import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** 运行时配置，全部来自环境变量（可用 server/.env） */
export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  allowRegister: boolean;
  initialCredits: number;
  adminUsername: string;
  adminPassword: string;
  model: {
    baseUrl: string;
    apiKey: string;
    name: string;
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
    /** 推理模型的思考强度；空字符串表示不传，由服务商默认 */
    reasoningEffort: '' | 'none' | 'minimal' | 'low' | 'medium' | 'high';
    /** 上游 5xx / 429 / 网络错误 / 超时时的重试次数（不含首次请求） */
    maxRetries: number;
    /** 首次重试的等待毫秒数，之后每次翻倍 */
    retryDelayMs: number;
    /** 评分阶段是否把答卷图片一起发给模型；设为 false 只用转录文字，杜绝重新读图编造 */
    scoreWithImage: boolean;
    /** 评分阶段并行采样次数，取中位数；1 表示只调用一次 */
    sampleCount: number;
  };
  /**
   * 额外的模型方案（MODEL_PROFILES，JSON）：名字 → 覆盖 model 里的字段。
   * 功能开关 model_profile 决定每个用户用哪套；default 就是上面的 model。
   */
  modelProfiles: Record<string, Partial<ModelConfig>>;
  /** 两阶段评分：先只转录答卷文字，再拿这份文字 + 评分标准打分 */
  ocr: {
    twoPass: boolean;
  };
  maxImageBytes: number;
  /** 把每次评分的题目、图片、模型原始输出（含思考过程）保存到本地，用于离线评测 */
  saveTraces: boolean;
  traceDir: string;
  /** 把老师确认过的历史成绩作为评分示例放进提示词（自动学习） */
  gold: {
    enabled: boolean;
    /** 每次最多带几个示例；过多会挤占上下文并放大锚定效应 */
    maxExamples: number;
  };
  corsOrigins: string[];
  seedDemoPreset: boolean;
  /** 管理后台 / 演示页静态文件目录；为空则在仓库根目录查找 */
  adminDir: string;
  demoDir: string;
  /** 是否提供 /demo/ 演示阅卷页 */
  serveDemo: boolean;
  rateLimit: { default: number; auth: number; judge: number };
}

export type ModelConfig = AppConfig['model'];

/** 方案里可以覆盖的字段及类型；重试相关保持全局一致 */
const PROFILE_KEYS: Record<string, 'string' | 'number' | 'boolean'> = {
  baseUrl: 'string',
  apiKey: 'string',
  name: 'string',
  timeoutMs: 'number',
  temperature: 'number',
  maxTokens: 'number',
  reasoningEffort: 'string',
  scoreWithImage: 'boolean',
  sampleCount: 'number',
};

/** 解析 MODEL_PROFILES：{"qwen-max": {"name": "qwen-vl-max"}, ...}；格式不对直接报错，避免静默回退 */
export function parseModelProfiles(raw: string | undefined): Record<string, Partial<ModelConfig>> {
  if (!raw || !raw.trim()) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('MODEL_PROFILES 不是合法的 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('MODEL_PROFILES 必须是 {名字: {...}} 形式的对象');
  const out: Record<string, Partial<ModelConfig>> = {};
  for (const [name, v] of Object.entries(data as Record<string, unknown>)) {
    if (!/^[\w.-]{1,40}$/.test(name) || name === 'default') throw new Error(`MODEL_PROFILES 的方案名不合法：${name}`);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`MODEL_PROFILES.${name} 必须是对象`);
    const p: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const want = Object.hasOwn(PROFILE_KEYS, k) ? PROFILE_KEYS[k] : undefined;
      if (!want) throw new Error(`MODEL_PROFILES.${name} 不支持字段 ${k}`);
      if (typeof x !== want || (want === 'number' && !Number.isFinite(x))) throw new Error(`MODEL_PROFILES.${name}.${k} 应为 ${want}`);
      if (want === 'string' && ['baseUrl', 'apiKey', 'name'].includes(k) && !(x as string).trim()) throw new Error(`MODEL_PROFILES.${name}.${k} 不能为空`);
      // 上限 60 秒：两阶段 + 重试的总时间要留在扩展评分请求的 240 秒期限内
      if (k === 'timeoutMs' && !(Number.isInteger(x) && (x as number) >= 1000 && (x as number) <= 60_000)) throw new Error(`MODEL_PROFILES.${name}.timeoutMs 应为 1000–60000 的整数`);
      if (k === 'temperature' && !((x as number) >= 0 && (x as number) <= 2)) throw new Error(`MODEL_PROFILES.${name}.temperature 应在 0–2 之间`);
      if ((k === 'maxTokens' || k === 'sampleCount') && !(Number.isInteger(x) && (x as number) >= 1)) throw new Error(`MODEL_PROFILES.${name}.${k} 应为正整数`);
      p[k] = k === 'baseUrl' && typeof x === 'string' ? x.replace(/\/+$/, '') : k === 'reasoningEffort' ? resolveReasoningEffort(String(x)) : x;
    }
    if (typeof p.sampleCount === 'number') p.sampleCount = Math.min(5, p.sampleCount);
    if (typeof p.maxTokens === 'number') p.maxTokens = Math.max(256, p.maxTokens);
    out[name] = p as Partial<ModelConfig>;
  }
  return out;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

/**
 * 思考强度：未设置时用 low。
 * none / minimal / low / medium / high 原样发给服务商；
 * off / default / disabled 表示不传这个参数（交给服务商默认，通常比 low 还慢）。
 */
function resolveReasoningEffort(v: string | undefined): AppConfig['model']['reasoningEffort'] {
  const raw = v?.trim().toLowerCase();
  if (raw === 'off' || raw === 'default' || raw === 'disabled') return '';
  return (['none', 'minimal', 'low', 'medium', 'high'] as const).find((e) => e === raw) ?? 'low';
}

/** JWT_SECRET 未设置时生成一个并持久化到数据目录，避免每次重启都让所有登录失效 */
function resolveJwtSecret(env: NodeJS.ProcessEnv, dbPath: string): string {
  if (env.JWT_SECRET && env.JWT_SECRET.length >= 32) return env.JWT_SECRET;
  if (env.JWT_SECRET) throw new Error('JWT_SECRET 至少需要 32 个字符');
  if (dbPath === ':memory:') return randomBytes(32).toString('hex');
  const file = resolve(dirname(dbPath), '.jwt-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dbPath = env.DB_PATH === ':memory:' ? ':memory:' : resolve(env.DB_PATH || 'data/app.db');
  return {
    port: num(env.PORT, 3000),
    host: env.HOST || '127.0.0.1',
    dbPath,
    jwtSecret: resolveJwtSecret(env, dbPath),
    jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
    allowRegister: bool(env.ALLOW_REGISTER, true),
    initialCredits: Math.max(0, Math.floor(num(env.INITIAL_CREDITS, 20))),
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    model: {
      baseUrl: (env.MODEL_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: env.MODEL_API_KEY || '',
      name: env.MODEL_NAME || '',
      timeoutMs: num(env.MODEL_TIMEOUT_MS, 60000),
      temperature: num(env.MODEL_TEMPERATURE, 0.1),
      // 推理模型（如 DeepSeek 的 reasoning_content）会先消耗输出额度再写正文，
      // 2000 常常不够，正文被挤空后表现为「模型没有返回内容」
      maxTokens: Math.max(256, Math.floor(num(env.MODEL_MAX_TOKENS, 8000))),
      // 默认 low：明显更快，实测评分结论不变。
      // 设为 none / off / disabled 可完全不传 reasoning_effort（模型不认识该参数时用）。
      reasoningEffort: resolveReasoningEffort(env.MODEL_REASONING_EFFORT),
      maxRetries: Math.min(5, Math.max(0, Math.floor(num(env.MODEL_MAX_RETRIES, 2)))),
      retryDelayMs: Math.max(0, num(env.MODEL_RETRY_DELAY_MS, 800)),
      scoreWithImage: bool(env.SCORE_WITH_IMAGE, true),
      sampleCount: Math.min(5, Math.max(1, Math.floor(num(env.MODEL_SAMPLE_COUNT, 1)))),
    },
    modelProfiles: parseModelProfiles(env.MODEL_PROFILES),
    maxImageBytes: num(env.MAX_IMAGE_BYTES, 4 * 1024 * 1024),
    ocr: {
      twoPass: bool(env.OCR_TWO_PASS, true),
    },
    saveTraces: bool(env.SAVE_TRACES, false),
    traceDir: env.TRACE_DIR ? resolve(env.TRACE_DIR) : resolve('data/traces'),
    gold: {
      enabled: bool(env.GOLD_ENABLED, false),
      maxExamples: Math.min(10, Math.max(0, Math.floor(num(env.GOLD_MAX_EXAMPLES, 4)))),
    },
    corsOrigins: (env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    seedDemoPreset: bool(env.SEED_DEMO_PRESET, true),
    adminDir: env.ADMIN_DIR ? resolve(env.ADMIN_DIR) : '',
    demoDir: env.DEMO_DIR ? resolve(env.DEMO_DIR) : '',
    serveDemo: bool(env.SERVE_DEMO, true),
    rateLimit: {
      default: num(env.RATE_LIMIT_DEFAULT, 120),
      auth: num(env.RATE_LIMIT_AUTH, 10),
      judge: num(env.RATE_LIMIT_JUDGE, 30),
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
