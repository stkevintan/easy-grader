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
import { In, Repository } from 'typeorm';
import { BillingService } from '../billing/billing.service';
import { APP_CONFIG, AppConfig } from '../config';
import { GradingTask, JudgeRecord } from '../entities';
import type { UpsertTaskDto } from './judge.dto';
import { GoldService } from './gold.service';
import { ModelOutputError, ModelService } from './model.service';
import {
  GradingInfo,
  TaskInfo,
  newGradingId,
  newJudgeId,
  normalizeTaskInput,
  toGradingInfo,
  toTaskInfo,
} from './task-info';

@Injectable()
export class JudgeService {
  private readonly log = new Logger('Judge');
  /** 同一用户同一张图并发请求时合并成一次 */
  private readonly inflight = new Map<string, Promise<GradingInfo>>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectRepository(GradingTask) private readonly tasks: Repository<GradingTask>,
    @InjectRepository(JudgeRecord) private readonly records: Repository<JudgeRecord>,
    private readonly billing: BillingService,
    private readonly model: ModelService,
    private readonly gold: GoldService,
  ) {}

  // ---------- 任务 ----------

  async findTask(userId: number, platformHost: string, exam: string, qIndex: string): Promise<TaskInfo | null> {
    const t = await this.tasks.findOne({
      where: { userId, platformHost, examTitle: exam, questionNo: qIndex },
      order: { updatedAt: 'DESC' },
    });
    return t ? toTaskInfo(t) : null;
  }

  private async taskEntity(userId: number, id: number): Promise<GradingTask> {
    const t = await this.tasks.findOneBy({ id, userId });
    if (!t) throw new NotFoundException('阅卷任务不存在');
    return t;
  }

  async getTask(userId: number, id: number): Promise<TaskInfo> {
    return toTaskInfo(await this.taskEntity(userId, id));
  }

  /** 平台 + 考试 + 题号相同则更新，否则新建 */
  async upsertTask(userId: number, dto: UpsertTaskDto): Promise<TaskInfo> {
    const { exam, question, majorInput, flat } = normalizeTaskInput(dto);
    const existing = await this.tasks.findOne({
      where: { userId, platformHost: dto.platformHost, examTitle: flat.examTitle, questionNo: flat.questionNo },
      order: { updatedAt: 'DESC' },
    });
    const structure = { exam, question, majorInput, ...flat, scoreStep: dto.scoreStep ?? 1 };
    if (existing) {
      return toTaskInfo(await this.tasks.save(Object.assign(existing, structure)));
    }
    return toTaskInfo(
      await this.tasks.save(
        this.tasks.create({
          userId,
          platformHost: dto.platformHost,
          judgeId: newJudgeId(),
          ...structure,
        }),
      ),
    );
  }

  async listTasks(userId: number) {
    const rows = await this.tasks.find({ where: { userId }, order: { updatedAt: 'DESC' }, take: 200 });
    const counts = await this.records
      .createQueryBuilder('r')
      .select('r.taskId', 'taskId')
      .addSelect('COUNT(*)', 'total')
      .addSelect('SUM(CASE WHEN r.confirmedAt IS NOT NULL THEN 1 ELSE 0 END)', 'confirmed')
      .where('r.userId = :userId AND r.status = :s', { userId, s: 'done' })
      .groupBy('r.taskId')
      .getRawMany<{ taskId: number; total: number; confirmed: number }>();
    const byId = new Map(counts.map((c) => [Number(c.taskId), c]));
    return rows.map((t) => ({
      ...toTaskInfo(t),
      judged: Number(byId.get(t.id)?.total ?? 0),
      confirmed: Number(byId.get(t.id)?.confirmed ?? 0),
    }));
  }

  async deleteTask(userId: number, id: number) {
    const t = await this.taskEntity(userId, id);
    await this.records.delete({ userId, taskId: t.id });
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

  async judge(userId: number, taskId: number, image: string, force = false): Promise<GradingInfo> {
    const task = await this.taskEntity(userId, taskId);
    const { sha256 } = this.decodeImage(image);

    if (!force) {
      const prev = await this.records.findOne({
        where: { userId, taskId, imageSha256: sha256, status: 'done' },
        order: { id: 'DESC' },
      });
      if (prev) return toGradingInfo(prev, task, true, this.billing.balance(userId));
    }

    const key = `${userId}:${taskId}:${sha256}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.runJudge(userId, task, image, sha256).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** 先扣费再调模型；模型失败则退还并记一条失败记录 */
  private async runJudge(
    userId: number,
    task: GradingTask,
    image: string,
    sha256: string,
  ): Promise<GradingInfo> {
    let rec = await this.records.save(
      this.records.create({
        userId,
        taskId: task.id,
        gradingId: newGradingId(),
        imageSha256: sha256,
        status: 'failed',
        charged: false,
      }),
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
      const examples = await this.gold.forTask(userId, task.id, rec.id);
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
      return toGradingInfo(rec, task, false, this.billing.balance(userId), {
        samples: v.samples,
        scoreSpread: v.spread,
      });
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

  /** gradingId 是原版 submitScore 用的标识；沿用数字 id 的旧请求也接受 */
  async confirm(userId: number, gradingId: string, modifiedScore: number, isAuto = false) {
    const r = /^\d+$/.test(gradingId)
      ? await this.records.findOneBy([
          { id: Number(gradingId), userId },
          { gradingId, userId },
        ])
      : await this.records.findOneBy({ gradingId, userId });
    if (!r || r.status !== 'done') throw new NotFoundException('评分记录不存在');
    const task = await this.taskEntity(userId, r.taskId);
    if (modifiedScore > task.maxScore) throw new BadRequestException('分数超过满分');
    r.finalScore = modifiedScore;
    r.autoSubmitted = isAuto;
    r.confirmedAt = new Date();
    await this.records.save(r);
    return { ok: true };
  }

  async listRecords(userId: number, taskId: number | undefined, page = 1, pageSize = 20) {
    const where = taskId ? { userId, taskId } : { userId };
    const [items, total] = await this.records.findAndCount({
      where,
      order: { id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const tasks = items.length
      ? await this.tasks.findBy({ id: In([...new Set(items.map((r) => r.taskId))]) })
      : [];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return {
      items: items.map((r) => {
        const task = byId.get(r.taskId);
        if (!task) return { ...r, gradingId: r.gradingId ?? '' };
        const view = toGradingInfo(r, task, false, this.billing.balance(userId));
        return {
          ...view,
          status: r.status,
          charged: r.charged,
          error: r.error,
          createdAt: r.createdAt,
          confirmedAt: r.confirmedAt,
        };
      }),
      total,
      page,
      pageSize,
    };
  }
}
