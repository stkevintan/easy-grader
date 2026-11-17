import { ForbiddenException, HttpException, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../config';
import { ModelProfilesService } from '../judge/model-profiles.service';
import {
  FeatureFlagAudit,
  FeatureFlagOverride,
  FlagScope,
  FlagSnapshot,
  Org,
  User,
} from '../entities';
import {
  FLAG_BY_KEY,
  FLAG_DEFINITIONS,
  FlagDefinition,
  FlagValue,
  FlagValidateContext,
  VERSION_RE,
  checkFlagValue,
  compareVersions,
} from './flag-definitions';

export type FlagSource = 'default' | 'global' | 'rollout' | 'org' | 'user';
export interface EvaluatedFlag {
  value: FlagValue;
  source: FlagSource;
  /** source 为 org / user 时的 id */
  targetId?: number;
}

/** 扩展在每个请求上带的版本号请求头 */
export const CLIENT_VERSION_HEADER = 'x-eg-version';

/** 0-99 的稳定分桶：同一开关下同一个用户始终落在同一个桶里，不同开关之间互相独立 */
export function rolloutBucket(key: string, userId: number): number {
  return createHash('sha256').update(`${key}:${userId}`).digest().readUInt32BE(0) % 100;
}

const snapshot = (o: FeatureFlagOverride | null): FlagSnapshot | null =>
  o ? { value: o.value, percent: o.percent } : null;

@Injectable()
export class FlagService {
  /** 覆盖表很小，整表缓存；本进程写入时立即失效，其他情况最多 10 秒后重新读 */
  private cache: { at: number; rows: FeatureFlagOverride[] } | null = null;
  private static readonly TTL_MS = 10_000;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectRepository(FeatureFlagOverride) private readonly overrides: Repository<FeatureFlagOverride>,
    @InjectRepository(FeatureFlagAudit) private readonly audit: Repository<FeatureFlagAudit>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Org) private readonly orgs: Repository<Org>,
    private readonly profiles: ModelProfilesService,
  ) {}

  get validateContext(): FlagValidateContext {
    return { modelProfiles: this.profiles.names() };
  }

  private async rows(): Promise<FeatureFlagOverride[]> {
    if (this.cache && Date.now() - this.cache.at < FlagService.TTL_MS) return this.cache.rows;
    const rows = await this.overrides.find({ order: { id: 'ASC' } });
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  /** 用户所在且仍启用的组织；停用的组织，它的开关覆盖不再生效 */
  private async orgIdOf(userId: number): Promise<number | null> {
    const u = await this.users.findOne({ where: { id: userId }, select: ['id', 'orgId'] });
    if (!u?.orgId) return null;
    return (await this.orgs.existsBy({ id: u.orgId, enabled: true })) ? u.orgId : null;
  }

  /** 计算一个用户的全部开关取值。优先级：user > org > rollout > global > 默认值 */
  async evaluateAll(userId: number, defs: FlagDefinition[] = FLAG_DEFINITIONS): Promise<Record<string, EvaluatedFlag>> {
    const rows = await this.rows();
    const orgId = await this.orgIdOf(userId);
    const ctx = this.validateContext;
    const out: Record<string, EvaluatedFlag> = {};
    for (const def of defs) {
      // 定义变了（比如删掉了某个模型方案）后旧的覆盖值可能不再合法：跳过它，往下一级找
      const mine = rows.filter((r) => r.flagKey === def.key && checkFlagValue(def, r.value, ctx) === null);
      const user = mine.find((r) => r.scope === 'user' && r.targetId === userId);
      if (user) { out[def.key] = { value: user.value, source: 'user', targetId: userId }; continue; }
      const org = orgId === null ? undefined : mine.find((r) => r.scope === 'org' && r.targetId === orgId);
      if (org) { out[def.key] = { value: org.value, source: 'org', targetId: org.targetId }; continue; }
      const rollout = mine.find((r) => r.scope === 'rollout');
      if (rollout && rolloutBucket(def.key, userId) < (rollout.percent ?? 0)) {
        out[def.key] = { value: rollout.value, source: 'rollout' };
        continue;
      }
      const global = mine.find((r) => r.scope === 'global');
      out[def.key] = global ? { value: global.value, source: 'global' } : { value: def.default, source: 'default' };
    }
    return out;
  }

  async get<T extends FlagValue>(key: string, userId: number): Promise<T> {
    const def = FLAG_BY_KEY.get(key);
    if (!def) throw new Error(`未定义的功能开关：${key}`);
    return (await this.evaluateAll(userId, [def]))[key].value as T;
  }

  /** 下发给扩展的开关（client: true） */
  async clientFlags(userId: number): Promise<Record<string, FlagValue>> {
    const all = await this.evaluateAll(userId, FLAG_DEFINITIONS.filter((d) => d.client));
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.value]));
  }

  /**
   * 扩展版本低于 min_extension_version 时拒绝（HTTP 426）。
   * 没带版本头的请求按最旧处理：旧版扩展本来就不带这个头，正是要拦住的对象。
   */
  async assertClientVersion(userId: number, header: string | string[] | undefined): Promise<void> {
    const min = await this.get<string>('min_extension_version', userId);
    if (!min) return;
    const v = Array.isArray(header) ? header[0] : header;
    const version = v && VERSION_RE.test(v) ? v : '0';
    if (compareVersions(version, min) < 0) {
      throw new HttpException(
        { statusCode: 426, code: 'EXTENSION_OUTDATED', minVersion: min, message: `扩展版本过旧（${v || '未知'}），请更新到 ${min} 或更高版本后再阅卷` },
        426,
      );
    }
  }

  /** 全自动提交的确认：开关关了、或置信度低于服务端下限时拒绝 */
  async assertAutoAllowed(userId: number, confidence: number | null): Promise<void> {
    const all = await this.evaluateAll(userId, [FLAG_BY_KEY.get('auto_mode')!, FLAG_BY_KEY.get('auto_min_confidence')!]);
    if (all.auto_mode.value !== true) throw new ForbiddenException('全自动阅卷已被管理员暂停，请改用手动确认');
    const min = all.auto_min_confidence.value as number;
    if ((confidence ?? 0) < min) {
      throw new ForbiddenException(`这份的置信度低于 ${Math.round(min * 100)}%，不能全自动提交，请人工确认`);
    }
  }

  // ---------- 管理 ----------

  async listForAdmin() {
    const rows = await this.overrides.find({ order: { id: 'ASC' } });
    const orgIds = rows.filter((r) => r.scope === 'org').map((r) => r.targetId);
    const userIds = rows.filter((r) => r.scope === 'user').map((r) => r.targetId);
    const orgNames = new Map(
      orgIds.length ? (await this.orgs.findBy({ id: In(orgIds) })).map((o) => [o.id, o.name] as const) : [],
    );
    const userNames = new Map<number, string>(
      userIds.length
        ? (
            await this.overrides.manager.query(
              `SELECT id, username FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`,
              userIds,
            )
          ).map((u: { id: number; username: string }) => [Number(u.id), u.username])
        : [],
    );
    const ctx = this.validateContext;
    return {
      modelProfiles: ctx.modelProfiles,
      flags: FLAG_DEFINITIONS.map((d) => ({
        key: d.key,
        type: d.type,
        default: d.default,
        description: d.description,
        owner: d.owner,
        removeBy: d.removeBy,
        client: d.client,
        overrides: rows
          .filter((r) => r.flagKey === d.key)
          .map((r) => ({
            scope: r.scope,
            targetId: r.targetId,
            targetName: r.scope === 'org' ? orgNames.get(r.targetId) ?? `#${r.targetId}` : r.scope === 'user' ? userNames.get(r.targetId) ?? `#${r.targetId}` : '',
            value: r.value,
            percent: r.percent,
            valid: checkFlagValue(d, r.value, ctx) === null,
            updatedAt: r.updatedAt,
          })),
      })),
    };
  }

  private def(key: string): FlagDefinition {
    const def = FLAG_BY_KEY.get(key);
    if (!def) throw new HttpException('功能开关不存在', 404);
    return def;
  }

  private normTarget(scope: FlagScope, targetId: number | undefined): number {
    if (scope === 'global' || scope === 'rollout') return 0;
    if (!targetId || !Number.isInteger(targetId) || targetId <= 0) throw new HttpException('请指定组织或用户', 400);
    return targetId;
  }

  async setOverride(
    actor: { id: number; username: string },
    key: string,
    input: { scope: FlagScope; targetId?: number; username?: string; value: unknown; percent?: number },
  ) {
    const def = this.def(key);
    if (input.scope === 'user' && !input.targetId && input.username) {
      const [u] = await this.overrides.manager.query('SELECT id FROM users WHERE username = ?', [input.username.trim()]);
      if (!u) throw new HttpException(`找不到用户 ${input.username.trim()}`, 400);
      input = { ...input, targetId: Number(u.id) };
    }
    const targetId = this.normTarget(input.scope, input.targetId);
    const err = checkFlagValue(def, input.value, this.validateContext);
    if (err) throw new HttpException(err, 400);
    let percent: number | null = null;
    if (input.scope === 'rollout') {
      if (input.percent === undefined || !Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100) {
        throw new HttpException('放量比例需为 0-100 的整数', 400);
      }
      percent = input.percent;
    }
    if (input.scope === 'org' && !(await this.orgs.existsBy({ id: targetId }))) throw new HttpException('组织不存在', 400);
    if (input.scope === 'user') {
      const [u] = await this.overrides.manager.query('SELECT id FROM users WHERE id = ?', [targetId]);
      if (!u) throw new HttpException('用户不存在', 400);
    }

    return this.overrides.manager.transaction(async (m) => {
      const repo = m.getRepository(FeatureFlagOverride);
      const existing = await repo.findOneBy({ flagKey: key, scope: input.scope, targetId });
      const before = snapshot(existing);
      const row = existing ?? repo.create({ flagKey: key, scope: input.scope, targetId });
      row.value = input.value as FlagValue;
      row.percent = percent;
      row.updatedBy = actor.id;
      const saved = await repo.save(row);
      await m.getRepository(FeatureFlagAudit).save(
        m.getRepository(FeatureFlagAudit).create({
          flagKey: key, scope: input.scope, targetId, before, after: snapshot(saved), actorId: actor.id, actorName: actor.username,
        }),
      );
      this.cache = null;
      return { ok: true };
    });
  }

  async removeOverride(actor: { id: number; username: string }, key: string, scope: FlagScope, targetId?: number) {
    this.def(key);
    const tid = this.normTarget(scope, targetId);
    return this.overrides.manager.transaction(async (m) => {
      const repo = m.getRepository(FeatureFlagOverride);
      const existing = await repo.findOneBy({ flagKey: key, scope, targetId: tid });
      if (!existing) throw new HttpException('没有这条覆盖', 404);
      await repo.delete({ id: existing.id });
      await m.getRepository(FeatureFlagAudit).save(
        m.getRepository(FeatureFlagAudit).create({
          flagKey: key, scope, targetId: tid, before: snapshot(existing), after: null, actorId: actor.id, actorName: actor.username,
        }),
      );
      this.cache = null;
      return { ok: true };
    });
  }

  async auditLog(key: string | undefined, page = 1, pageSize = 50) {
    const [items, total] = await this.audit.findAndCount({
      where: key ? { flagKey: key } : {},
      order: { id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }
}
