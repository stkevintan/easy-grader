import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { BillingService } from '../billing/billing.service';
import { APP_CONFIG, AppConfig } from '../config';
import { GradingTask, JudgeRecord } from '../entities';
import type { UpsertTaskDto } from './judge.dto';
import { GoldService } from './gold.service';
import { ModelOutputError, ModelService } from './model.service';

export interface JudgeResultView {
  recordId: number;
  taskId: number;
  score: number;
  maxScore: number;
  confidence: number;
  reasons: string[];
  comment: string;
  ocrText: string;
  model: string;
  cached: boolean;
  balance: number;
  /** 多次采样的分数（只有实时评分、且开启多次采样时才有） */
  samples?: number[];
  /** 多次采样的最大分差 */
  scoreSpread?: number;
}

@Injectable()
export class JudgeService {
  private readonly log = new Logger('Judge');
  /** 同一用户同一张图并发请求时合并成一次 */
  private readonly inflight = new Map<string, Promise<JudgeResultView>>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectRepository(GradingTask) private readonly tasks: Repository<GradingTask>,
    @InjectRepository(JudgeRecord) private readonly records: Repository<JudgeRecord>,
    private readonly billing: BillingService,
    private readonly model: ModelService,
    private readonly gold: GoldService,
  ) {}

  // ---------- 任务 ----------

  findTask(_userId: number, unitId: number, platformHost: string, examTitle: string, questionNo: string) {
    return this.tasks.findOne({
      where: { unitId, platformHost, examTitle, questionNo },
      order: { updatedAt: 'DESC' },
    });
  }

  async getTask(_userId: number, unitId: number, id: number): Promise<GradingTask> {
    const t = await this.tasks.findOneBy({ id, unitId });
    if (!t) throw new NotFoundException('阅卷任务不存在');
    return t;
  }

  /** 平台 + 考试 + 题号相同则更新，否则新建 */
  async upsertTask(userId: number, unitId: number, dto: UpsertTaskDto): Promise<GradingTask> {
    const existing = await this.findTask(userId, unitId, dto.platformHost, dto.examTitle, dto.questionNo);
    const fields = {
      subject: dto.subject,
      questionType: dto.questionType ?? '',
      maxScore: dto.maxScore,
      scoreStep: dto.scoreStep ?? 1,
      questionText: dto.questionText ?? '',
      referenceAnswer: dto.referenceAnswer ?? '',
      rubric: dto.rubric ?? '',
    };
    if (existing) return this.tasks.save(Object.assign(existing, fields));
    return this.tasks.save(
      this.tasks.create({
        userId,
        unitId,
        platformHost: dto.platformHost,
        examTitle: dto.examTitle,
        questionNo: dto.questionNo,
        ...fields,
      }),
    );
  }

  async listTasks(userId: number, unitId: number) {
    const rows = await this.tasks.find({ where: { unitId }, order: { updatedAt: 'DESC' }, take: 200 });
    const counts = await this.records
      .createQueryBuilder('r')
      .select('r.taskId', 'taskId')
      .addSelect('COUNT(*)', 'total')
      .addSelect('SUM(CASE WHEN r.confirmedAt IS NOT NULL THEN 1 ELSE 0 END)', 'confirmed')
      .where('r.unitId = :unitId AND r.status = :s', { unitId, s: 'done' })
      .groupBy('r.taskId')
      .getRawMany<{ taskId: number; total: number; confirmed: number }>();
    const byId = new Map(counts.map((c) => [Number(c.taskId), c]));
    return rows.map((t) => ({
      ...t,
      judged: Number(byId.get(t.id)?.total ?? 0),
      confirmed: Number(byId.get(t.id)?.confirmed ?? 0),
    }));
  }

  async deleteTask(userId: number, unitId: number, id: number) {
    const t = await this.getTask(userId, unitId, id);
    await this.records.delete({ unitId, taskId: t.id });
    await this.tasks.delete({ id: t.id });
    return { ok: true };
  }

  // ---------- 评分 ----------

  private decodeImage(dataUrl: string): { bytes: number; sha256: string } {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 100) throw new BadRequestException('答卷图片为空或太小');
    if (buf.length > this.cfg.maxImageBytes)
      throw new PayloadTooLargeException(`答卷图片超过 ${Math.round(this.cfg.maxImageBytes / 1024 / 1024)}MB`);
    return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  }

  async judge(userId: number, unitId: number, taskId: number, image: string, force = false): Promise<JudgeResultView> {
    const task = await this.getTask(userId, unitId, taskId);
    const { sha256 } = this.decodeImage(image);

    if (!force) {
      const prev = await this.records.findOne({
        where: { unitId, taskId, imageSha256: sha256, status: 'done' },
        order: { id: 'DESC' },
      });
      if (prev) return this.view(prev, task, true, {}, userId);
    }

    const key = `${unitId}:${taskId}:${sha256}`;
    const running = this.inflight.get(key);
    if (running) {
      // 评分结果可以在单元内共享，但余额是每个人自己的，不能沿用发起者的
      const shared = await running;
      return { ...shared, balance: this.billing.balance(userId) };
    }
    const p = this.runJudge(userId, unitId, task, image, sha256).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** 先扣费再调模型；模型失败则退还并记一条失败记录 */
  private async runJudge(userId: number, unitId: number, task: GradingTask, image: string, sha256: string): Promise<JudgeResultView> {
    let rec = await this.records.save(
      this.records.create({ userId, unitId, taskId: task.id, imageSha256: sha256, status: 'failed', charged: false }),
    );
    try {
      this.billing.adjust(userId, -1, 'judge', rec.id, `任务 #${task.id}`);
    } catch (e) {
      // 余额不足等：这条记录还没开始评分，直接删掉，避免留下空的失败记录
      await this.records.delete({ id: rec.id });
      throw e;
    }
    rec.charged = true;

    const started = Date.now();
    try {
      // 自动学习：把本题老师确认过的成绩作为评分示例，帮模型校准尺度
      const examples = await this.gold.forTask(unitId, task.id, rec.id);
      const v = await this.model.grade(task, image, sha256, rec.id, examples);
      Object.assign(rec, {
        status: 'done',
        aiScore: v.score,
        confidence: v.confidence,
        reasons: v.reasons,
        comment: v.comment,
        ocrText: v.ocrText,
        model: v.model,
        latencyMs: Date.now() - started,
      });
      rec = await this.records.save(rec);
      return this.view(rec, task, false, { samples: v.samples, scoreSpread: v.spread }, userId);
    } catch (e) {
      this.billing.adjust(userId, 1, 'refund', rec.id, '评分失败退还');
      rec.charged = false;
      rec.error = (e as Error).message.slice(0, 500);
      rec.latencyMs = Date.now() - started;
      await this.records.save(rec);
      if (e instanceof ModelOutputError) {
        this.log.warn(`任务 #${task.id} 模型输出无法解析：${(e as Error).message}`);
        throw new BadGatewayException(`模型输出无法解析：${(e as Error).message}，本次不扣次数`);
      }
      throw e;
    }
  }

  private view(
    r: JudgeRecord,
    task: GradingTask,
    cached: boolean,
    extra: { samples?: number[]; scoreSpread?: number } = {},
    balanceUserId = r.userId,
  ): JudgeResultView {
    return {
      recordId: r.id,
      taskId: task.id,
      score: r.aiScore ?? 0,
      maxScore: task.maxScore,
      confidence: r.confidence ?? 0,
      reasons: r.reasons ?? [],
      comment: r.comment,
      ocrText: r.ocrText,
      model: r.model,
      cached,
      balance: this.billing.balance(balanceUserId),
      ...extra,
    };
  }

  async confirm(_userId: number, unitId: number, recordId: number, finalScore: number, autoSubmitted = false) {
    const r = await this.records.findOneBy({ id: recordId, unitId });
    if (!r || r.status !== 'done') throw new NotFoundException('评分记录不存在');
    const task = await this.getTask(_userId, unitId, r.taskId);
    if (finalScore > task.maxScore) throw new BadRequestException('分数超过满分');
    r.finalScore = finalScore;
    r.autoSubmitted = autoSubmitted;
    r.confirmedAt = new Date();
    await this.records.save(r);
    return { ok: true };
  }

  async listRecords(userId: number, unitId: number, taskId: number | undefined, page = 1, pageSize = 20) {
    const where = taskId ? { unitId, taskId } : { unitId };
    const [items, total] = await this.records.findAndCount({
      where,
      order: { id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }
}
