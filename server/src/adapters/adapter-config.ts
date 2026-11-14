/**
 * 平台适配配置（与 extension/src/shared/adapter-config.ts 保持一致）。
 *
 * 设计参考了原扩展 compat 适配器的 documentOpInfo 结构：
 * 图片区域、给分方式（输入框 / 分数按钮）、提交按钮、考试名与题号来源。
 * 所有选择器均为 CSS 选择器，按数组顺序依次尝试，取第一个命中的。
 */
export type PicType = 'img' | 'canvas' | 'background' | 'region';
export type ScoreMode = 'input' | 'buttons';
export type ClickType = 'click' | 'events';

export interface PicConfig {
  selectors: string[];
  type: PicType;
  /** 命中多个元素时是否全部拼接（多页答卷） */
  multiple: boolean;
}

export interface TextSource {
  selectors: string[];
  /** 用户手动填写的固定值，优先于选择器 */
  fixed?: string;
  /** 从文本中提取的正则（取第 1 个捕获组），可选 */
  regex?: string;
}

export interface AdapterConfig {
  version: 1;
  pics: PicConfig;
  scoreMode: ScoreMode;
  /** scoreMode = input：分数输入框 */
  scoreInput: { selectors: string[] };
  /** scoreMode = buttons：分数按钮容器内的按钮，按按钮文字匹配分数 */
  scoreButtons: { selectors: string[]; clickType: ClickType };
  /** 提交/下一份按钮；为空表示平台在给分后自动提交 */
  submit: { selectors: string[]; clickType: ClickType };
  /** 提交后需要额外点的确认按钮（弹窗），可选 */
  confirm?: { selectors: string[] };
  examTitle: TextSource;
  questionNo: TextSource;
  /** 满分来源（可选；没有则使用任务里的满分） */
  maxScore?: TextSource;
  /** 提交后等待答卷图片变化的超时 */
  nextTimeoutMs: number;
  /** 给分后等待多少毫秒再提交 */
  submitDelayMs: number;
}

const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 20 && v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 500);

const textSource = (v: unknown): v is TextSource => {
  if (!v || typeof v !== 'object') return false;
  const t = v as TextSource;
  return (
    isStrArr(t.selectors) &&
    (t.fixed === undefined || (typeof t.fixed === 'string' && t.fixed.length <= 200)) &&
    (t.regex === undefined || (typeof t.regex === 'string' && t.regex.length <= 200))
  );
};

/** 返回错误信息；合法时返回 null */
export function validateAdapterConfig(v: unknown): string | null {
  if (!v || typeof v !== 'object') return 'config 必须是对象';
  const c = v as AdapterConfig;
  if (c.version !== 1) return 'config.version 必须为 1';
  if (!c.pics || !isStrArr(c.pics.selectors) || c.pics.selectors.length === 0) return '缺少答卷图片选择器';
  if (!['img', 'canvas', 'background', 'region'].includes(c.pics.type)) return 'pics.type 不合法';
  if (typeof c.pics.multiple !== 'boolean') return 'pics.multiple 必须是布尔值';
  if (!['input', 'buttons'].includes(c.scoreMode)) return 'scoreMode 不合法';
  if (!c.scoreInput || !isStrArr(c.scoreInput.selectors)) return 'scoreInput 不合法';
  if (!c.scoreButtons || !isStrArr(c.scoreButtons.selectors)) return 'scoreButtons 不合法';
  if (c.scoreMode === 'input' && c.scoreInput.selectors.length === 0) return '输入框模式需要分数输入框选择器';
  if (c.scoreMode === 'buttons' && c.scoreButtons.selectors.length === 0) return '按钮模式需要分数按钮选择器';
  if (!c.submit || !isStrArr(c.submit.selectors)) return 'submit 不合法';
  for (const k of ['scoreButtons', 'submit'] as const) {
    if (!['click', 'events'].includes(c[k].clickType)) return `${k}.clickType 不合法`;
  }
  if (c.confirm !== undefined && (!c.confirm || !isStrArr(c.confirm.selectors))) return 'confirm 不合法';
  if (!textSource(c.examTitle)) return 'examTitle 不合法';
  if (!textSource(c.questionNo)) return 'questionNo 不合法';
  if (c.maxScore !== undefined && !textSource(c.maxScore)) return 'maxScore 不合法';
  if (!Number.isFinite(c.nextTimeoutMs) || c.nextTimeoutMs < 500 || c.nextTimeoutMs > 60000)
    return 'nextTimeoutMs 需在 500-60000 之间';
  if (!Number.isFinite(c.submitDelayMs) || c.submitDelayMs < 0 || c.submitDelayMs > 10000)
    return 'submitDelayMs 需在 0-10000 之间';
  if (JSON.stringify(c).length > 20000) return 'config 过大';
  return null;
}

/** 规范化 host 模式：去协议、端口和前导 *. / www. */
export function normalizeHostPattern(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/^www\./, '');
}

/** host 是否命中模式：精确相等或是其子域 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  const p = normalizeHostPattern(pattern);
  return h === p || h.endsWith('.' + p);
}
