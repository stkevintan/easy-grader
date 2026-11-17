import { Injectable, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, type AppConfig, type ModelConfig } from '../config';
import { ModelSetting } from '../entities';

/** 允许在控制台覆盖的字段；其余（重试次数、图片上限等）仍由环境变量决定 */
export const MODEL_OVERRIDE_FIELDS = [
  'name',
  'baseUrl',
  'apiKey',
  'temperature',
  'maxTokens',
  'reasoningEffort',
  'sampleCount',
  'scoreWithImage',
  'timeoutMs',
] as const;

export type ModelOverrideField = (typeof MODEL_OVERRIDE_FIELDS)[number];
export type ModelOverrides = Partial<Pick<ModelConfig, ModelOverrideField>>;

/**
 * 模型配置 = 环境变量（MODEL_*）+ 管理端在控制台改的覆盖值。
 * 只在内存里缓存一行，保存后立刻生效，不用重新部署。
 */
@Injectable()
export class ModelSettingsService implements OnModuleInit {
  private row: ModelSetting | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectRepository(ModelSetting) private readonly repo: Repository<ModelSetting>,
  ) {}

  async onModuleInit() {
    await this.reload();
  }

  private async reload() {
    this.row = await this.repo.findOneBy({ id: 1 });
  }

  /** 当前生效的模型配置 */
  current(): ModelConfig {
    const r = this.row;
    if (!r) return this.cfg.model;
    const out: ModelConfig = { ...this.cfg.model };
    for (const k of MODEL_OVERRIDE_FIELDS) {
      const v = r[k];
      if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  }

  /** 控制台展示用：哪些字段被覆盖了（密钥只报「有没有覆盖」） */
  overrideKeys(): ModelOverrideField[] {
    const r = this.row;
    if (!r) return [];
    return MODEL_OVERRIDE_FIELDS.filter((k) => r[k] !== null && r[k] !== undefined);
  }

  updated(): { at: string | null; byName: string } {
    return { at: this.row?.updatedAt?.toISOString() ?? null, byName: this.row?.updatedByName ?? '' };
  }

  /** 改覆盖值；未传的字段保持原样，传空字符串表示清掉这一项、退回环境变量 */
  async update(patch: ModelOverrides, actor: { id: number; name: string }): Promise<void> {
    const row = this.row ?? this.repo.create({ id: 1 });
    for (const k of MODEL_OVERRIDE_FIELDS) {
      if (!Object.hasOwn(patch, k)) continue;
      const v = patch[k];
      (row as unknown as Record<string, unknown>)[k] = v === '' ? null : v;
    }
    row.updatedBy = actor.id;
    row.updatedByName = actor.name;
    this.row = await this.repo.save(row);
  }

  /** 全部退回环境变量 */
  async reset(actor: { id: number; name: string }): Promise<void> {
    if (!this.row) return;
    for (const k of MODEL_OVERRIDE_FIELDS) (this.row as unknown as Record<string, unknown>)[k] = null;
    this.row.updatedBy = actor.id;
    this.row.updatedByName = actor.name;
    this.row = await this.repo.save(this.row);
  }
}
