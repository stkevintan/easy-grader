import { Logger } from '@nestjs/common';

/** better-sqlite3 连接里用到的部分 */
export interface RawDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
  exec(sql: string): unknown;
}

const hasTable = (db: RawDb, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const hasColumn = (db: RawDb, table: string, column: string) =>
  !!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column);

/**
 * 管理单元 → 组织（控制台 P3）。在 TypeORM 同步表结构之前执行，只在库里还有旧表时做事：
 *   1. 先用 VACUUM INTO 备份整个库到 <db>.pre-orgs-<时间>.bak（内存库跳过）
 *   2. 停用所有旧邀请令牌：它们属于的单元会被删掉，不能变成「不属于任何组织」的邀请继续用
 *   3. 删除单元级的功能开关覆盖（修改记录保留）
 *   4. 删掉 management_units、unit_memberships
 * 之后 synchronize 会把 invite_tokens.unitId 换成可空的 orgId，并给 users 加 orgId。
 * 返回备份文件路径（没有执行迁移时为 null）。
 */
export function migrateUnitsToOrgs(db: RawDb, dbPath: string, now = new Date()): string | null {
  if (!hasTable(db, 'management_units') && !hasTable(db, 'unit_memberships')) return null;
  const log = new Logger('Migration');
  let backup: string | null = null;
  if (dbPath !== ':memory:') {
    backup = `${dbPath}.pre-orgs-${now.toISOString().replace(/[:.]/g, '-')}.bak`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    log.log(`迁移前已备份数据库：${backup}`);
  }
  db.exec('BEGIN');
  try {
    if (hasTable(db, 'invite_tokens') && hasColumn(db, 'invite_tokens', 'unitId')) {
      db.exec('UPDATE invite_tokens SET disabled = 1');
    }
    if (hasTable(db, 'feature_flag_overrides')) {
      db.exec("DELETE FROM feature_flag_overrides WHERE scope = 'unit'");
    }
    db.exec('DROP TABLE IF EXISTS unit_memberships');
    db.exec('DROP TABLE IF EXISTS management_units');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  log.log('管理单元已改为组织：旧单元表已删除，单元级开关覆盖已删除，旧邀请令牌已停用');
  return backup;
}
