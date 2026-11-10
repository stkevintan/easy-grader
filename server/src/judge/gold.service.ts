import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../config';
import { JudgeRecord } from '../entities';

/** 一条老师确认过的评分示例 */
export interface GoldExample {
  recordId: number;
  score: number;
  ocrText: string;
}

const OCR_LIMIT = 600;

/**
 * 从同一任务已确认的记录里挑示例，给模型提供本题的评分尺度。
 *
 * 只取老师人工确认过的（autoSubmitted=false）：自动提交的 finalScore 只是模型自己的分，
 * 拿来当示例等于让模型自我强化，没有任何信息量。
 *
 * 挑选规则：按分数分组后轮转取，尽量覆盖不同分数段，避免示例全是高分把模型往上锚。
 */
export function pickGoldExamples(
  rows: Pick<JudgeRecord, 'id' | 'finalScore' | 'ocrText'>[],
  max: number,
): GoldExample[] {
  const byScore = new Map<number, GoldExample[]>();
  for (const r of rows) {
    const score = r.finalScore;
    const text = (r.ocrText ?? '').trim();
    if (!Number.isFinite(score) || !text) continue;
    const list = byScore.get(score as number) ?? [];
    list.push({ recordId: r.id, score: score as number, ocrText: text.slice(0, OCR_LIMIT) });
    byScore.set(score as number, list);
  }
  const scores = [...byScore.keys()].sort((a, b) => a - b);
  const picked: GoldExample[] = [];
  for (let round = 0; picked.length < max; round++) {
    let advanced = false;
    for (const s of scores) {
      const bucket = byScore.get(s)!;
      if (round >= bucket.length) continue;
      picked.push(bucket[round]);
      advanced = true;
      if (picked.length >= max) break;
    }
    if (!advanced) break;
  }
  // 按分数排序，提示词更稳定，也方便人看
  return picked.sort((a, b) => a.score - b.score || a.recordId - b.recordId);
}

@Injectable()
export class GoldService {
  private readonly log = new Logger('Gold');

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectRepository(JudgeRecord) private readonly records: Repository<JudgeRecord>,
  ) {}

  get enabled(): boolean {
    return this.cfg.gold.enabled && this.cfg.gold.maxExamples > 0;
  }

  async forTask(userId: number, taskId: number, excludeRecordId?: number): Promise<GoldExample[]> {
    if (!this.enabled) return [];
    try {
      const qb = this.records
        .createQueryBuilder('r')
        .where('r.userId = :userId AND r.taskId = :taskId', { userId, taskId })
        .andWhere('r.status = :status', { status: 'done' })
        .andWhere('r.autoSubmitted = 0')
        .andWhere('r.finalScore IS NOT NULL')
        .andWhere("r.ocrText <> ''")
        .orderBy('r.id', 'DESC')
        .take(300);
      if (excludeRecordId) qb.andWhere('r.id <> :excludeRecordId', { excludeRecordId });
      const rows = await qb.getMany();
      return pickGoldExamples(rows, this.cfg.gold.maxExamples);
    } catch (e) {
      // 示例只是锦上添花，查不到不影响正常评分
      this.log.warn(`读取评分示例失败：${(e as Error).message}`);
      return [];
    }
  }
}
