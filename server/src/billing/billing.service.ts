import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomInt } from 'node:crypto';
import { DataSource } from 'typeorm';
import { rawSqlite, sqliteNow } from '../common/sqlite';
import type { LedgerReason } from '../entities';

/** 去掉 0/O/1/I/L 等易混字符 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateCode(): string {
  const pick = (n: number) => Array.from({ length: n }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `EG-${pick(4)}-${pick(4)}`;
}

export function normalizeCode(input: string): string {
  const s = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const body = s.startsWith('EG') ? s.slice(2) : s;
  return body.length === 8 ? `EG-${body.slice(0, 4)}-${body.slice(4)}` : input.trim().toUpperCase();
}

export class InsufficientCreditsError extends BadRequestException {
  constructor() {
    super('评分次数不足，请兑换或联系管理员充值');
  }
}

/**
 * 额度账本。所有额度变化都在一个 SQLite 同步事务里完成：
 * 更新余额（带条件防止扣成负数）+ 写一条流水，二者要么都成功要么都失败。
 */
@Injectable()
export class BillingService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  private get db() {
    return rawSqlite(this.ds);
  }

  /** 变更余额；delta < 0 且余额不足时抛 InsufficientCreditsError。返回新余额 */
  adjust(userId: number, delta: number, reason: LedgerReason, refId: number | null = null, note = ''): number {
    if (!Number.isInteger(delta) || delta === 0) throw new BadRequestException('额度变化必须是非零整数');
    const tx = this.db.transaction(() => {
      const res = this.db
        .prepare('UPDATE users SET credits = credits + ? WHERE id = ? AND credits + ? >= 0')
        .run(delta, userId, delta);
      if (res.changes === 0) {
        const exists = this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
        if (!exists) throw new NotFoundException('用户不存在');
        throw new InsufficientCreditsError();
      }
      const { credits } = this.db.prepare('SELECT credits FROM users WHERE id = ?').get(userId) as { credits: number };
      this.db
        .prepare(
          'INSERT INTO credit_ledger (userId, delta, balanceAfter, reason, refId, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(userId, delta, credits, reason, refId, note.slice(0, 200), sqliteNow());
      return credits;
    });
    return tx.immediate();
  }

  balance(userId: number): number {
    const row = this.db.prepare('SELECT credits FROM users WHERE id = ?').get(userId) as { credits: number } | undefined;
    if (!row) throw new NotFoundException('用户不存在');
    return row.credits;
  }

  /** 兑换码：校验 + 记录使用 + 计数 + 加额度，一个事务 */
  redeem(userId: number, rawCode: string): { credits: number; balance: number } {
    const code = normalizeCode(rawCode);
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, credits, maxUses, usedCount, expiresAt, disabled FROM redeem_codes WHERE code = ?')
        .get(code) as
        | { id: number; credits: number; maxUses: number; usedCount: number; expiresAt: string | null; disabled: number }
        | undefined;
      if (!row || row.disabled) throw new BadRequestException('兑换码无效');
      if (row.expiresAt && new Date(row.expiresAt.replace(' ', 'T') + 'Z') < new Date())
        throw new BadRequestException('兑换码已过期');
      if (row.usedCount >= row.maxUses) throw new BadRequestException('兑换码已被用完');
      const used = this.db.prepare('SELECT 1 FROM redeem_uses WHERE codeId = ? AND userId = ?').get(row.id, userId);
      if (used) throw new BadRequestException('你已经使用过这个兑换码');

      this.db.prepare('INSERT INTO redeem_uses (codeId, userId, createdAt) VALUES (?, ?, ?)').run(row.id, userId, sqliteNow());
      this.db.prepare('UPDATE redeem_codes SET usedCount = usedCount + 1 WHERE id = ?').run(row.id);
      const balance = this.adjust(userId, row.credits, 'redeem', row.id, code);
      return { credits: row.credits, balance };
    });
    return tx.immediate();
  }

  /** 批量生成兑换码 */
  createCodes(opts: {
    count: number;
    credits: number;
    maxUses: number;
    expiresAt: Date | null;
    note: string;
    createdBy: number;
  }): string[] {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO redeem_codes (code, credits, maxUses, usedCount, expiresAt, disabled, note, createdBy, createdAt) VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)',
    );
    const tx = this.db.transaction(() => {
      const codes: string[] = [];
      while (codes.length < opts.count) {
        const c = generateCode();
        const r = insert.run(
          c,
          opts.credits,
          opts.maxUses,
          opts.expiresAt ? sqliteNow(opts.expiresAt) : null,
          opts.note.slice(0, 200),
          opts.createdBy,
          sqliteNow(),
        );
        if (r.changes) codes.push(c);
      }
      return codes;
    });
    return tx.immediate();
  }
}
