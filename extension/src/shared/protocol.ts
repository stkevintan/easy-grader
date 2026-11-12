import type { AdapterConfig } from './adapter-config';

/** 发布版固定为线上地址；开发版默认本机，可在 popup 设置里修改 */
export const DEFAULT_SERVER = __SERVER_URL__;

export interface PublicUser {
  id: number;
  username: string;
  role: string;
  credits: number;
}

export interface Settings {
  serverUrl: string;
  /** 自动连续阅卷时，置信度低于该值就暂停让人工确认 */
  autoMinConfidence: number;
  /** 自动连续阅卷每份之间的最小间隔（毫秒），避免对阅卷平台造成高频访问 */
  autoIntervalMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: DEFAULT_SERVER,
  autoMinConfidence: 0.7,
  autoIntervalMs: 2500,
};

/**
 * 服务端下发的功能开关（GET /api/flags）。由管理员按单位/用户/比例控制，扩展只读。
 * 新增开关时扩展要能处理缺失的字段（旧服务端不会返回）。
 */
export interface ClientFlags {
  /** 全自动是否可用（紧急关闭开关） */
  auto_mode: boolean;
  /** 全自动置信度下限；老师自己的设置只能更严 */
  auto_min_confidence: number;
  /** 最低支持的扩展版本，空表示不限制 */
  min_extension_version: string;
}

/** 从来没拉到过开关时的保守取值：全自动不可用 */
export const SAFE_FLAGS: ClientFlags = {
  auto_mode: false,
  auto_min_confidence: 0.7,
  min_extension_version: '',
};

export interface FlagsResult {
  flags: ClientFlags;
  /** 这次没能从服务端刷新，用的是缓存或保守取值 */
  stale: boolean;
  /** 当前扩展版本 */
  version: string;
}

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

/** 对齐咖喱阅卷 taskInfo.exam */
export interface ExamInfo {
  exam: string;
  subject: string;
  q_index: string;
}

export type QuestionContent = Record<string, string | number | undefined> & { score?: number };

/** 对齐 taskInfo.question；不同题型在 content 里放不同字段 */
export interface QuestionInfo {
  type: string;
  content: QuestionContent;
  extra?: string;
}

/** 对齐 taskInfo.majorInput */
export interface MajorInput {
  key: string;
  name: string;
  content: string;
}

/** 服务端下发的任务结构，对齐咖喱阅卷的 taskInfo */
export interface TaskInfo {
  taskId: number;
  judgeId: string;
  platformHost: string;
  scoreStep: number;
  exam: ExamInfo;
  question: QuestionInfo;
  majorInput: MajorInput;
}

/** 新建/更新任务时提交的结构 */
export interface TaskInput {
  platformHost: string;
  scoreStep?: number;
  exam: ExamInfo;
  question: QuestionInfo;
  majorInput?: MajorInput;
}

/** 评分结果，对齐 judge / submitScore 的 grading_id、modified_score、is_auto */
export interface GradingInfo {
  gradingId: string;
  taskId: number;
  score: number;
  maxScore: number;
  reason: string;
  ocr: string;
  modifiedScore: number | null;
  isAuto: boolean;
  confidence: number;
  reasons: string[];
  comment: string;
  model: string;
  cached: boolean;
  balance: number;
  /** 多次采样的分数；实时评分且开启多次采样时才有 */
  samples?: number[];
  scoreSpread?: number;
}

export interface Preset {
  id: number;
  name: string;
  hostPattern: string;
  pathPattern: string;
  config: AdapterConfig;
  scope: 'public' | 'private';
  ownerId: number | null;
}

/** 内容脚本 / popup -> background 的命令（background 只接受这些，其他一律拒绝） */
export type BgRequest =
  | { cmd: 'auth.status' }
  | { cmd: 'auth.login'; username: string; password: string }
  | { cmd: 'auth.register'; username: string; password: string; inviteToken: string }
  | { cmd: 'auth.logout' }
  | { cmd: 'billing.redeem'; code: string }
  | { cmd: 'settings.get' }
  | { cmd: 'settings.set'; settings: Partial<Settings> }
  | { cmd: 'meta.get' }
  | { cmd: 'flags.get'; refresh?: boolean }
  | { cmd: 'adapter.resolve'; host: string; path: string }
  | { cmd: 'adapter.save'; name: string; hostPattern: string; pathPattern: string; config: AdapterConfig }
  | { cmd: 'task.lookup'; platformHost: string; exam: string; q_index: string }
  | { cmd: 'task.upsert'; task: TaskInput }
  | { cmd: 'judge.run'; taskId: number; image: string; force?: boolean }
  | { cmd: 'record.confirm'; gradingId: string; modifiedScore: number; isAuto: boolean }
  | { cmd: 'image.fetch'; url: string }
  | { cmd: 'tab.capture' }
  | { cmd: 'site.list' }
  | { cmd: 'site.enable'; origin: string }
  | { cmd: 'site.disable'; origin: string };

export type BgResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string; status?: number };

/** popup -> 内容脚本 */
export type TabRequest = { cmd: 'panel.toggle' } | { cmd: 'panel.status' };

/** background 转发的服务端错误；status 是 HTTP 状态码（0 表示连不上服务端） */
export class BgError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export async function bg<T>(req: BgRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as BgResponse<T> | undefined;
  if (!res) throw new Error('扩展后台没有响应，请刷新页面重试');
  if (!res.ok) throw new BgError(res.error, res.status);
  return res.data;
}
