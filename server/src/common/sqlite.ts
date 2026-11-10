import type BetterSqlite3 from 'better-sqlite3';
import type { DataSource } from 'typeorm';

/**
 * 取得 TypeORM 底层的 better-sqlite3 连接。
 * 额度、兑换这类需要强一致的操作用它的同步事务完成：
 * better-sqlite3 是同步执行的，事务期间不会被其他异步请求插入。
 */
export function rawSqlite(ds: DataSource): BetterSqlite3.Database {
  const db = (ds.driver as unknown as { databaseConnection?: BetterSqlite3.Database }).databaseConnection;
  if (!db) throw new Error('当前数据源不是 better-sqlite3');
  return db;
}

/** SQLite datetime('now') 风格的 UTC 时间串 */
export function sqliteNow(d = new Date()): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
