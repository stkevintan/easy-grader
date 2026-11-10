import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../config';
import { AdapterPreset, PresetScope } from '../entities';
import { AdapterConfig, hostMatches, normalizeHostPattern, validateAdapterConfig } from './adapter-config';
import { BUILTIN_PRESETS } from './builtin-presets';

export interface PresetInput {
  name: string;
  hostPattern: string;
  pathPattern?: string;
  config: AdapterConfig;
  note?: string;
}

@Injectable()
export class AdaptersService implements OnApplicationBootstrap {
  private readonly log = new Logger('Adapters');

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectRepository(AdapterPreset) private readonly presets: Repository<AdapterPreset>,
  ) {}

  /** 内置预设只在不存在时写入，管理员修改后不会被覆盖 */
  async onApplicationBootstrap() {
    for (const p of BUILTIN_PRESETS) {
      if (p.demo && !this.cfg.seedDemoPreset) continue;
      const exists = await this.presets.existsBy({ hostPattern: p.hostPattern, pathPattern: p.pathPattern, scope: 'public' });
      if (exists) continue;
      const err = validateAdapterConfig(p.config);
      if (err) throw new Error(`内置预设 ${p.name} 不合法：${err}`);
      await this.presets.save(
        this.presets.create({ ...p, scope: 'public', ownerId: null, enabled: true }),
      );
      this.log.log(`已写入内置适配预设：${p.name}`);
    }
  }

  private check(input: PresetInput) {
    const err = validateAdapterConfig(input.config);
    if (err) throw new BadRequestException(err);
    const host = normalizeHostPattern(input.hostPattern);
    if (!host || !/^[a-z0-9.-]+$/.test(host)) throw new BadRequestException('hostPattern 不合法');
    return { ...input, hostPattern: host, pathPattern: (input.pathPattern ?? '').slice(0, 200), note: (input.note ?? '').slice(0, 500) };
  }

  /**
   * 给扩展用：按 host + path 找最合适的预设。
   * 优先级：自己的私有预设 > 公共预设；有 pathPattern 且命中的 > 没有 pathPattern 的；host 越精确越优先。
   */
  async resolve(userId: number, host: string, path: string): Promise<AdapterPreset | null> {
    const all = await this.presets.find({ where: [{ scope: 'public', enabled: true }, { ownerId: userId, enabled: true }] });
    const scored = all
      .filter((p) => hostMatches(host, p.hostPattern) && (!p.pathPattern || path.includes(p.pathPattern)))
      .map((p) => ({
        p,
        // 路径片段越长越具体
        score: (p.ownerId === userId ? 10000 : 0) + (p.pathPattern ? 1000 + p.pathPattern.length * 10 : 0) + p.hostPattern.length,
      }))
      .sort((a, b) => b.score - a.score || b.p.updatedAt.getTime() - a.p.updatedAt.getTime());
    return scored[0]?.p ?? null;
  }

  /** 用户保存自己点选出来的配置（同 host+path 覆盖） */
  async saveMine(userId: number, input: PresetInput) {
    const v = this.check(input);
    const existing = await this.presets.findOneBy({ ownerId: userId, hostPattern: v.hostPattern, pathPattern: v.pathPattern });
    if (existing) return this.presets.save(Object.assign(existing, v, { enabled: true }));
    return this.presets.save(this.presets.create({ ...v, scope: 'private', ownerId: userId, enabled: true }));
  }

  listMine(userId: number) {
    return this.presets.find({ where: { ownerId: userId }, order: { updatedAt: 'DESC' } });
  }

  async deleteMine(userId: number, id: number) {
    const r = await this.presets.delete({ id, ownerId: userId });
    if (!r.affected) throw new NotFoundException('预设不存在');
    return { ok: true };
  }

  // ---------- 管理员 ----------

  listAll(q?: string) {
    const qb = this.presets.createQueryBuilder('p').orderBy('p.updatedAt', 'DESC').take(500);
    if (q) qb.where('p.name LIKE :q OR p.hostPattern LIKE :q', { q: `%${q}%` });
    return qb.getMany();
  }

  async adminCreate(input: PresetInput & { scope?: PresetScope; enabled?: boolean }) {
    const v = this.check(input);
    return this.presets.save(
      this.presets.create({ ...v, scope: input.scope ?? 'public', ownerId: null, enabled: input.enabled ?? true }),
    );
  }

  async adminUpdate(id: number, patch: Partial<PresetInput> & { scope?: PresetScope; enabled?: boolean }) {
    const p = await this.presets.findOneBy({ id });
    if (!p) throw new NotFoundException('预设不存在');
    // DTO 转换后未传的可选字段是 undefined，不能让它覆盖已有值
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as typeof patch;
    const merged = { name: p.name, hostPattern: p.hostPattern, pathPattern: p.pathPattern, config: p.config, note: p.note, ...defined };
    const v = this.check(merged);
    Object.assign(p, v);
    if (defined.scope) {
      p.scope = defined.scope;
      if (defined.scope === 'public') p.ownerId = null;
    }
    if (defined.enabled !== undefined) p.enabled = defined.enabled;
    return this.presets.save(p);
  }

  async adminDelete(id: number) {
    const r = await this.presets.delete({ id });
    if (!r.affected) throw new NotFoundException('预设不存在');
    return { ok: true };
  }
}
