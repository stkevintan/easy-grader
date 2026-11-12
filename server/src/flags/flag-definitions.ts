/**
 * 功能开关的定义：开关只能在这里声明，管理后台只能改它们的取值。
 *
 * 每个开关写清负责人和预计删除时间（removeBy）。功能全量稳定后，
 * 把开关定义和代码里的旧分支一起删掉；permanent 的开关是长期运营用的。
 */
export type FlagType = 'boolean' | 'number' | 'string';
export type FlagValue = boolean | number | string;

export interface FlagDefinition {
  key: string;
  type: FlagType;
  /** 没有任何覆盖时的取值 */
  default: FlagValue;
  description: string;
  owner: string;
  /** 预计删除日期（YYYY-MM-DD）；'permanent' 表示长期运营开关 */
  removeBy: string;
  /** 是否通过 GET /api/flags 下发给扩展；只在服务端使用的开关不下发 */
  client: boolean;
  /** 额外校验，返回错误信息；类型已由调用方检查 */
  validate?: (v: FlagValue, ctx: FlagValidateContext) => string | null;
}

export interface FlagValidateContext {
  /** 服务端配置的模型方案名（含 default） */
  modelProfiles: string[];
}

export const VERSION_RE = /^\d+(\.\d+){0,3}$/;

/** 比较点分版本号，缺省段按 0；a<b 返回负数 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x) || 0);
  const pb = b.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const FLAG_DEFINITIONS: FlagDefinition[] = [
  {
    key: 'auto_mode',
    type: 'boolean',
    default: true,
    description: '全自动阅卷是否可用。关闭后扩展只能手动/半自动，服务端也拒绝全自动提交的确认（紧急关闭开关）',
    owner: 'Kevin Tan',
    removeBy: 'permanent',
    client: true,
  },
  {
    key: 'auto_min_confidence',
    type: 'number',
    default: 0.7,
    description: '全自动的置信度下限（0-1）。老师在扩展设置里只能调得更严，不能低于这个值',
    owner: 'Kevin Tan',
    removeBy: 'permanent',
    client: true,
    validate: (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? null : '需要 0 到 1 之间的数字'),
  },
  {
    key: 'min_extension_version',
    type: 'string',
    default: '',
    description: '最低支持的扩展版本（如 0.2.0），低于它的扩展不能评分和提交，面板提示更新；空表示不限制',
    owner: 'Kevin Tan',
    removeBy: 'permanent',
    client: true,
    validate: (v) => (v === '' || (typeof v === 'string' && VERSION_RE.test(v)) ? null : '版本号格式应为 0.2.0，或留空'),
  },
  {
    key: 'model_profile',
    type: 'string',
    default: 'default',
    description: '评分用哪套模型方案（MODEL_PROFILES 里定义，default 是 MODEL_* 环境变量）。用于模型和提示词的灰度',
    owner: 'Kevin Tan',
    removeBy: 'permanent',
    client: false,
    validate: (v, ctx) =>
      typeof v === 'string' && ctx.modelProfiles.includes(v) ? null : `可选：${ctx.modelProfiles.join(' / ')}`,
  },
];

export const FLAG_BY_KEY = new Map(FLAG_DEFINITIONS.map((d) => [d.key, d]));

/** 检查取值类型并跑开关自带的校验；返回错误信息或 null */
export function checkFlagValue(def: FlagDefinition, v: unknown, ctx: FlagValidateContext): string | null {
  if (typeof v !== def.type) return `${def.key} 的取值必须是 ${def.type}`;
  if (def.type === 'number' && !Number.isFinite(v)) return `${def.key} 的取值必须是有效数字`;
  if (def.type === 'string' && (v as string).length > 200) return `${def.key} 的取值过长`;
  return def.validate?.(v as FlagValue, ctx) ?? null;
}
