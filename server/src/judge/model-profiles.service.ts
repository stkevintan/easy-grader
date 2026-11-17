import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, type AppConfig, type ModelConfig } from '../config';
import { ModelProfile } from '../entities';
import { VisionService } from './vision.service';

/** 可以在控制台按方案覆盖的字段 */
export const PROFILE_FIELDS = [
  'model',
  'baseUrl',
  'apiKey',
  'temperature',
  'maxTokens',
  'reasoningEffort',
  'ocrReasoningEffort',
  'sampleCount',
  'scoreWithImage',
  'timeoutMs',
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type ProfilePatch = Partial<{
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort: string;
  /** 转录阶段的思考强度；空字符串表示不传 */
  ocrReasoningEffort: string;
  sampleCount: number;
  scoreWithImage: boolean;
  timeoutMs: number;
}>;

export interface ProfileView {
  name: string;
  model: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  params: {
    temperature: number;
    maxTokens: number;
    reasoningEffort: string;
    ocrReasoningEffort: string;
    sampleCount: number;
    scoreWithImage: boolean;
    timeoutMs: number;
  };
  /** 哪些字段来自控制台（其余沿用环境变量） */
  overrides: string[];
  vision: { ok: boolean; checkedAt: string | null; error: string };
  updated: { at: string | null; byName: string };
  ready: boolean;
}

/**
 * 模型方案：default 是默认模型，其余名字对应功能开关 model_profile。
 * 每个方案 = 环境变量 MODEL_* 打底 + 方案行里填过的字段；保存前必须通过视觉探测。
 */
@Injectable()
export class ModelProfilesService implements OnModuleInit {
  private rows = new Map<string, ModelProfile>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectRepository(ModelProfile) private readonly repo: Repository<ModelProfile>,
    private readonly vision: VisionService,
  ) {}

  async onModuleInit() {
    await this.reload();
  }

  private async reload() {
    this.rows = new Map((await this.repo.find()).map((r) => [r.name, r]));
  }

  /** default 在前，其余按名字排序；env 里定义但还没落库的方案也算 */
  names(): string[] {
    const extra = new Set([...Object.keys(this.cfg.modelProfiles), ...this.rows.keys()]);
    extra.delete('default');
    return ['default', ...[...extra].sort()];
  }

  has(name: string): boolean {
    return name === 'default' || this.rows.has(name) || Object.hasOwn(this.cfg.modelProfiles, name);
  }

  /** 某个方案实际生效的模型配置 */
  config(name = 'default'): ModelConfig {
    const out: ModelConfig = { ...this.cfg.model };
    if (name !== 'default' && Object.hasOwn(this.cfg.modelProfiles, name)) Object.assign(out, this.cfg.modelProfiles[name]);
    const row = this.rows.get(name);
    if (row) {
      if (row.model) out.name = row.model;
      if (row.baseUrl) out.baseUrl = row.baseUrl.replace(/\/+$/, '');
      if (row.apiKey != null) out.apiKey = row.apiKey;
      if (row.temperature != null) out.temperature = row.temperature;
      if (row.maxTokens != null) out.maxTokens = row.maxTokens;
      if (row.reasoningEffort != null) out.reasoningEffort = row.reasoningEffort as ModelConfig['reasoningEffort'];
      if (row.ocrReasoningEffort != null) out.ocrReasoningEffort = row.ocrReasoningEffort as ModelConfig['ocrReasoningEffort'];
      if (row.sampleCount != null) out.sampleCount = row.sampleCount;
      if (row.scoreWithImage != null) out.scoreWithImage = row.scoreWithImage;
      if (row.timeoutMs != null) out.timeoutMs = row.timeoutMs;
    }
    out.baseUrl = (out.baseUrl || '').replace(/\/+$/, '');
    // 转录强度：显式设置优先，否则继承这个方案实际的打分强度（不是全局的）
    const explicitOcr =
      (row?.ocrReasoningEffort as ModelConfig['ocrReasoningEffort'] | null) ??
      (name !== 'default' ? this.cfg.modelProfiles[name]?.ocrReasoningEffort : undefined) ??
      this.cfg.model.ocrReasoningEffort;
    out.ocrReasoningEffort = explicitOcr ?? out.reasoningEffort;
    return out;
  }

  view(name: string): ProfileView {
    const m = this.config(name);
    const row = this.rows.get(name);
    const overrides = row
      ? PROFILE_FIELDS.filter((k) => (k === 'model' || k === 'baseUrl' ? row[k] != null && row[k] !== '' : row[k] != null))
      : [];
    return {
      name,
      model: m.name,
      baseUrl: m.baseUrl,
      apiKeyConfigured: Boolean(m.apiKey),
      params: {
        temperature: m.temperature,
        maxTokens: m.maxTokens,
        reasoningEffort: m.reasoningEffort || '',
        ocrReasoningEffort: m.ocrReasoningEffort ?? '',
        sampleCount: m.sampleCount,
        scoreWithImage: m.scoreWithImage,
        timeoutMs: m.timeoutMs,
      },
      overrides,
      vision: { ok: row?.visionOk ?? false, checkedAt: row?.visionCheckedAt?.toISOString() ?? null, error: row?.visionError ?? '' },
      updated: { at: row?.updatedAt?.toISOString() ?? null, byName: row?.updatedByName ?? '' },
      ready: Boolean(m.apiKey && m.baseUrl && m.name),
    };
  }

  list(): ProfileView[] {
    return this.names().map((n) => this.view(n));
  }

  /** 保存方案；改过模型/地址/密钥或第一次保存时先做视觉探测，探测不过直接拒绝 */
  async save(name: string, patch: ProfilePatch, actor: { id: number; name: string }): Promise<void> {
    if (!/^[\w.-]{1,40}$/.test(name)) throw new BadRequestException('方案名只能是字母、数字、下划线、点和短横线');
    const existing = this.rows.get(name);
    // 在副本上改，探测通过、落库成功之后才更新缓存：探测失败时线上配置不能被动过
    const row: ModelProfile = existing ? ({ ...existing } as ModelProfile) : this.repo.create({ name });
    const next: ModelConfig = { ...this.config(name) };

    if (patch.model !== undefined) next.name = patch.model.trim();
    if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
    if (patch.apiKey !== undefined) next.apiKey = patch.apiKey === '' ? this.cfg.model.apiKey : patch.apiKey.trim();
    if (patch.temperature !== undefined) next.temperature = patch.temperature;
    if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens;
    if (patch.reasoningEffort !== undefined) next.reasoningEffort = patch.reasoningEffort as ModelConfig['reasoningEffort'];
    if (patch.ocrReasoningEffort !== undefined) next.ocrReasoningEffort = patch.ocrReasoningEffort as ModelConfig['ocrReasoningEffort'];
    if (patch.sampleCount !== undefined) next.sampleCount = patch.sampleCount;
    if (patch.scoreWithImage !== undefined) next.scoreWithImage = patch.scoreWithImage;
    if (patch.timeoutMs !== undefined) next.timeoutMs = patch.timeoutMs;

    if (patch.baseUrl !== undefined && next.baseUrl !== '') {
      let url: URL;
      try {
        url = new URL(next.baseUrl);
      } catch {
        throw new BadRequestException('接口地址不是合法的 URL，例如 https://api.deepseek.com');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BadRequestException('接口地址必须是 http(s)');
    }
    if (!next.name || !next.baseUrl || !next.apiKey) throw new BadRequestException('模型名、接口地址、API Key 都必须有值（可以沿用环境变量）');

    const changed = patch.model !== undefined || patch.baseUrl !== undefined || patch.apiKey !== undefined || !row.visionOk;
    if (changed) {
      const probe = await this.vision.probe(next);
      row.visionOk = probe.ok;
      row.visionError = probe.error;
      row.visionCheckedAt = new Date();
      if (!probe.ok) throw new BadRequestException(`这个模型不能读图，没有保存：${probe.error}`);
    }

    if (patch.model !== undefined) row.model = next.name;
    if (patch.baseUrl !== undefined) row.baseUrl = next.baseUrl;
    if (patch.apiKey !== undefined) row.apiKey = patch.apiKey === '' ? null : next.apiKey;
    if (patch.temperature !== undefined) row.temperature = patch.temperature;
    if (patch.maxTokens !== undefined) row.maxTokens = patch.maxTokens;
    if (patch.reasoningEffort !== undefined) row.reasoningEffort = patch.reasoningEffort;
    if (patch.ocrReasoningEffort !== undefined) row.ocrReasoningEffort = patch.ocrReasoningEffort;
    if (patch.sampleCount !== undefined) row.sampleCount = patch.sampleCount;
    if (patch.scoreWithImage !== undefined) row.scoreWithImage = patch.scoreWithImage;
    if (patch.timeoutMs !== undefined) row.timeoutMs = patch.timeoutMs;
    row.updatedBy = actor.id;
    row.updatedByName = actor.name;
    await this.repo.save(row);
    await this.reload();
  }

  /** 重新探测一个方案，把结果写回去 */
  async test(name: string): Promise<ProfileView> {
    if (!this.has(name)) throw new NotFoundException('模型方案不存在');
    const probe = await this.vision.probe(this.config(name));
    // 探测期间别人可能改了/删了这个方案：只把视觉结果写到当前这一行，别整行覆盖
    const fresh = await this.repo.findOneBy({ name });
    if (!fresh) throw new NotFoundException('模型方案在处理过程中被删除');
    fresh.visionOk = probe.ok;
    fresh.visionError = probe.error;
    fresh.visionCheckedAt = new Date();
    await this.repo.save(fresh);
    await this.reload();
    return this.view(name);
  }

  async remove(name: string): Promise<void> {
    if (name === 'default') throw new BadRequestException('默认模型不能删除，只能恢复为环境变量');
    const row = this.rows.get(name);
    if (!row) throw new NotFoundException('模型方案不存在');
    await this.repo.remove(row);
    await this.reload();
  }

  /** 把方案里控制台覆盖的字段全部清掉，退回环境变量 */
  async reset(name: string): Promise<void> {
    const row = this.rows.get(name);
    if (!row) return;
    if (name === 'default') {
      await this.repo.remove(row);
    } else {
      // model / baseUrl 是非空列，回退时写成空串（等价于「沿用环境变量」）；其余可空
      row.model = '';
      row.baseUrl = '';
      // 视觉探测结果属于旧模型，恢复后必须重新探测
      row.visionOk = false;
      row.visionCheckedAt = null;
      row.visionError = '';
      for (const k of PROFILE_FIELDS) {
        if (k === 'model' || k === 'baseUrl') continue;
        (row as unknown as Record<string, unknown>)[k] = null;
      }
      await this.repo.save(row);
    }
    await this.reload();
  }
}
