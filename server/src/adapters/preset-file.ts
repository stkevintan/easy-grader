import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { normalizeHostPattern, validateAdapterConfig } from './adapter-config';
import type { BuiltinPreset } from './builtin-presets';

/** 仓库自带的预设目录：server/presets（编译后 dist/adapters 与源码 src/adapters 都往上两级） */
export const DEFAULT_PRESETS_DIR = resolve(__dirname, '..', '..', 'presets');

/**
 * 解析一个预设 YAML 文件。格式：
 *
 *   presets:
 *     - name: 小闲阅卷
 *       hostPattern: xiaoxianai.cn   # 会同时匹配子域名
 *       pathPattern: /webPaper       # 可选：路径包含的片段
 *       note: 说明                   # 可选
 *       config: { ...AdapterConfig }
 *
 * 任何一条不合法都抛错，避免带着坏配置上线。
 */
export function parsePresetFile(text: string, source: string): BuiltinPreset[] {
  const doc = parse(text) as unknown;
  if (doc == null) return [];
  const list = (doc as { presets?: unknown }).presets;
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error(`${source}：presets 必须是数组`);
  return list.map((raw, i) => {
    const at = `${source} 第 ${i + 1} 条`;
    if (!raw || typeof raw !== 'object') throw new Error(`${at}：必须是对象`);
    const p = raw as Record<string, unknown>;
    if (typeof p.name !== 'string' || !p.name.trim()) throw new Error(`${at}：缺少 name`);
    if (typeof p.hostPattern !== 'string') throw new Error(`${at}：缺少 hostPattern`);
    const hostPattern = normalizeHostPattern(p.hostPattern);
    if (!hostPattern || !/^[a-z0-9.-]+$/.test(hostPattern)) throw new Error(`${at}：hostPattern 不合法`);
    if (p.pathPattern != null && typeof p.pathPattern !== 'string') throw new Error(`${at}：pathPattern 必须是字符串`);
    if (p.note != null && typeof p.note !== 'string') throw new Error(`${at}：note 必须是字符串`);
    const err = validateAdapterConfig(p.config);
    if (err) throw new Error(`${at}（${p.name}）：${err}`);
    return {
      name: p.name.trim(),
      hostPattern,
      pathPattern: ((p.pathPattern as string | undefined) ?? '').slice(0, 200),
      note: ((p.note as string | undefined) ?? '').slice(0, 500),
      config: p.config as BuiltinPreset['config'],
    };
  });
}

/** 读取目录下所有 .yaml / .yml 文件（按文件名排序）；目录不存在时返回空 */
export function loadPresetDir(dir: string): BuiltinPreset[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .flatMap((f) => parsePresetFile(readFileSync(join(dir, f), 'utf8'), f));
}
