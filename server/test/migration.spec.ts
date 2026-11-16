import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateUnitsToOrgs } from '../src/migrations';

describe('管理单元 → 组织的启动迁移', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eg-mig-'));
    dbPath = join(dir, 'app.db');
    db = new Database(dbPath);
    // 旧库的相关表
    db.exec(`
      CREATE TABLE management_units (id INTEGER PRIMARY KEY, name TEXT, enabled INTEGER DEFAULT 1);
      CREATE TABLE unit_memberships (id INTEGER PRIMARY KEY, unitId INTEGER, userId INTEGER, role TEXT);
      CREATE TABLE invite_tokens (id INTEGER PRIMARY KEY, tokenHash TEXT, unitId INTEGER, disabled INTEGER DEFAULT 0);
      CREATE TABLE feature_flag_overrides (id INTEGER PRIMARY KEY, flagKey TEXT, scope TEXT, targetId INTEGER DEFAULT 0, value TEXT);
    `);
    db.prepare('INSERT INTO management_units (id, name) VALUES (1, ?)').run('一中');
    db.prepare('INSERT INTO unit_memberships (unitId, userId, role) VALUES (1, 1, ?)').run('owner');
    db.prepare('INSERT INTO invite_tokens (tokenHash, unitId, disabled) VALUES (?, 1, 0)').run('h');
    db.prepare("INSERT INTO feature_flag_overrides (flagKey, scope, targetId, value) VALUES ('auto_mode', 'unit', 1, 'false')").run();
    db.prepare("INSERT INTO feature_flag_overrides (flagKey, scope, targetId, value) VALUES ('auto_mode', 'global', 0, 'true')").run();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('删旧表、停用旧邀请、删单元级覆盖，并先备份', () => {
    const backup = migrateUnitsToOrgs(db as unknown as Parameters<typeof migrateUnitsToOrgs>[0], dbPath);
    expect(backup).toBeTruthy();
    expect(existsSync(backup!)).toBe(true);
    // 旧表没了
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).not.toContain('management_units');
    expect(tables).not.toContain('unit_memberships');
    // 旧邀请停用
    expect((db.prepare('SELECT disabled FROM invite_tokens').get() as any).disabled).toBe(1);
    // 单元级覆盖删掉，全局覆盖保留
    const scopes = db.prepare('SELECT scope FROM feature_flag_overrides').all().map((r: any) => r.scope);
    expect(scopes).toEqual(['global']);
  });

  it('没有旧表时什么都不做，也不备份', () => {
    migrateUnitsToOrgs(db as any, dbPath);
    db.exec('DROP TABLE invite_tokens; DROP TABLE feature_flag_overrides;');
    const again = migrateUnitsToOrgs(db as any, dbPath);
    expect(again).toBeNull();
    expect(readdirSync(dir).filter((f) => f.includes('.bak'))).toHaveLength(1);
  });

  it('内存库不备份', () => {
    const mem = new Database(':memory:');
    mem.exec('CREATE TABLE management_units (id INTEGER PRIMARY KEY)');
    expect(migrateUnitsToOrgs(mem as any, ':memory:')).toBeNull();
    mem.close();
  });
});
