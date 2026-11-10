/**
 * 配置驱动的平台适配器：读考试/题号/满分 → 写分 → 提交 → 等待下一份答卷。
 * 图片读取在 capture.ts。
 */
import type { AdapterConfig, TextSource } from '../shared/adapter-config';
import { backgroundUrl, picElements } from './capture';
import { clickElement, isVisible, queryAll, queryOne, readText, setInputValue } from './dom';

export class AdapterError extends Error {}

export interface PaperInfo {
  examTitle: string;
  questionNo: string;
  maxScore: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function readSource(src: TextSource | undefined): string {
  if (!src) return '';
  if (src.fixed) return src.fixed;
  const raw = readText(queryOne(src.selectors));
  if (!raw || !src.regex) return raw;
  try {
    const m = raw.match(new RegExp(src.regex));
    return (m?.[1] ?? m?.[0] ?? raw).trim();
  } catch {
    return raw;
  }
}

export function readPaperInfo(cfg: AdapterConfig): PaperInfo {
  const max = Number(readSource(cfg.maxScore));
  return {
    examTitle: readSource(cfg.examTitle),
    questionNo: readSource(cfg.questionNo),
    maxScore: Number.isFinite(max) && max > 0 ? max : null,
  };
}

/**
 * 把图像缩到最长边 256 像素后，对全部像素做 FNV-1a 哈希。
 *
 * 不能只抽样少量像素：真实答卷大多是大片白底 + 一小段手写，
 * 固定位置的采样点很容易全部落在空白处，导致不同答卷算出相同指纹。
 * 缩放后整图参与计算，任何一处笔迹变化都会反映到哈希里；1200x1600 的图约 0.3ms。
 * 读不到像素（跨域污染）时抛错，由调用方退回其他特征。
 */
function pixelHash(source: CanvasImageSource, width: number, height: number): string {
  const k = Math.min(1, 256 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let hash = 0x811c9dc5;
  let first = -1;
  let uniform = true;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] * 3 + d[i + 1] * 5 + d[i + 2] + d[i + 3] * 7) & 0xffff;
    if (first < 0) first = v;
    else if (v !== first) uniform = false;
    hash ^= v;
    hash = Math.imul(hash, 0x01000193);
  }
  // 纯色（被清空、还没画上答卷）属于过渡状态
  if (uniform) return 'blank#loading';
  return (hash >>> 0).toString(36);
}

/**
 * 当前答卷的指纹，用来判断“已经换到下一份”。
 * img：地址 + 像素哈希（有的平台换卷时图片地址不变）；canvas：像素哈希（读不到就用 data-eg-src）；背景图：地址。
 */
export function fingerprint(cfg: AdapterConfig): string {
  return fingerprintParts(cfg).join('|');
}

/**
 * 写分前确认真的是同一份答卷。页面重绘、图片重新加载、画布短暂清空都会让指纹变化，
 * 所以先等一会儿多读几次：真的换卷了不会变回去，仍然会被判为不一致。
 * 返回 null 表示一致；否则返回最后读到的指纹。
 */
export async function confirmUnchanged(cfg: AdapterConfig, expected: string, settleMs = 1500): Promise<string | null> {
  const deadline = Date.now() + settleMs;
  for (;;) {
    const now = fingerprint(cfg);
    if (now === expected) return null;
    if (Date.now() >= deadline) return now;
    await sleep(300);
  }
}

/** 每张答卷图各自的指纹；找不到答卷时返回空数组 */
export function fingerprintParts(cfg: AdapterConfig): string[] {
  let els: HTMLElement[];
  try {
    els = picElements(cfg.pics);
  } catch {
    return [];
  }
  return els
    .map((el) => {
      if (cfg.pics.type === 'background') return backgroundUrl(el) ?? '';
      const img = el instanceof HTMLImageElement ? el : el.querySelector('img');
      if (cfg.pics.type === 'img' && img) {
        const src = img.currentSrc || img.src;
        // 图片还在加载时尺寸为 0，先只用地址，等加载完下一轮轮询会得到完整指纹
        if (!img.complete || !img.naturalWidth) return `${src}#loading`;
        try {
          return `${src}#${pixelHash(img, img.naturalWidth, img.naturalHeight)}`;
        } catch {
          return src; // 跨域图片读不到像素，只能比地址
        }
      }
      const canvas = el instanceof HTMLCanvasElement ? el : el.querySelector('canvas');
      if (canvas) {
        const tainted = canvas.getAttribute('data-eg-src');
        if (!canvas.width || !canvas.height) return tainted ?? '';
        try {
          return `${canvas.width}x${canvas.height}:${pixelHash(canvas, canvas.width, canvas.height)}`;
        } catch {
          return tainted ?? `${canvas.width}x${canvas.height}`;
        }
      }
      // region：用元素内文本 + 尺寸凑一个（区域截图的平台通常也会换文本）
      const r = el.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}:${readText(el).slice(0, 200)}`;
    });
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/** 在分数按钮里找文字等于该分数的那个（兼容“6分”“6.0”“满分”这类写法） */
function findScoreButton(cfg: AdapterConfig, score: number, maxScore: number): HTMLElement | null {
  const buttons = queryAll(cfg.scoreButtons.selectors).filter(isVisible);
  const want = Number(fmt(score));
  for (const b of buttons) {
    const t = readText(b).replace(/\s/g, '');
    if (t === '满分' && want === maxScore) return b;
    const n = Number(t.replace(/分$/, ''));
    if (Number.isFinite(n) && Math.abs(n - want) < 1e-6) return b;
  }
  return null;
}

/** 当前可写的分数输入框；平台可能临时重渲染，所以每次写分都重新查 */
function inputTarget(cfg: AdapterConfig): HTMLInputElement | HTMLTextAreaElement {
  const inputs = queryAll(cfg.scoreInput.selectors).filter(isVisible);
  if (inputs.length !== 1) {
    throw new AdapterError(inputs.length ? '找到多个分数输入框，无法确定写到哪一个，请重新点选适配' : '找不到分数输入框');
  }
  const el = inputs[0];
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new AdapterError('点选的分数框不是输入框');
  if (el.disabled || el.readOnly) throw new AdapterError('分数输入框当前不可编辑');
  return el;
}

export function setScore(cfg: AdapterConfig, score: number, maxScore: number) {
  if (cfg.scoreMode === 'buttons') {
    const btn = findScoreButton(cfg, score, maxScore);
    if (!btn) throw new AdapterError(`打分板上找不到「${fmt(score)}」分的按钮，请手动给分`);
    clickElement(btn, cfg.scoreButtons.clickType);
    return;
  }
  setInputValue(inputTarget(cfg), fmt(score));
}

/** 写完分后读回来校验，避免平台把输入改掉/拒绝了我们却继续提交 */
export function verifyScore(cfg: AdapterConfig, score: number): boolean {
  if (cfg.scoreMode === 'buttons') return true;
  const inputs = queryAll(cfg.scoreInput.selectors).filter(isVisible);
  if (inputs.length !== 1) return false;
  return Number((inputs[0] as HTMLInputElement).value) === Number(fmt(score));
}

/**
 * 用更接近真实键盘输入的方式写分。
 * 有的平台只认键盘/输入法事件，直接改 value 再派发 input 时，它内部的表单状态仍是空，
 * 提交时就会提示「分数不能为空」。
 */
export async function typeScore(cfg: AdapterConfig, score: number) {
  const el = inputTarget(cfg);
  const value = fmt(score);
  el.focus();
  el.select?.();
  let typed = false;
  try {
    typed = document.execCommand('insertText', false, value);
  } catch {
    typed = false;
  }
  if (!typed) {
    // execCommand 被禁用时退化为逐字符事件
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, '');
    for (const ch of value) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
      setter?.call(el, el.value + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    }
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
}

/** 平台提交时的校验提示，例如「分数不能为空」 */
const REJECT_RE = /(分数|得分|分值)不能为空/;

export function rejectText(): string | null {
  // innerText 会跳过隐藏元素；jsdom 里没有 innerText，退回 textContent
  const text = document.body ? document.body.innerText || document.body.textContent || '' : '';
  return text.match(REJECT_RE)?.[0] ?? null;
}

/** 提交后等新的校验提示出现；超时或没有变化返回 null */
export async function waitRejectChange(before: string | null, timeoutMs = 800): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(200);
    const now = rejectText();
    if (now && now !== before) return now;
    if (Date.now() >= deadline) return null;
  }
}

export async function submit(cfg: AdapterConfig) {
  if (cfg.submitDelayMs) await sleep(cfg.submitDelayMs);
  if (cfg.submit.selectors.length) {
    const btn = queryAll(cfg.submit.selectors).find(isVisible);
    if (!btn) throw new AdapterError('找不到提交按钮');
    if ((btn as HTMLButtonElement).disabled) throw new AdapterError('提交按钮当前不可点击');
    clickElement(btn, cfg.submit.clickType);
  }
  // 平台弹出的二次确认框
  if (cfg.confirm?.selectors.length) {
    for (let i = 0; i < 10; i++) {
      await sleep(150);
      const c = queryAll(cfg.confirm.selectors).find(isVisible);
      if (c) {
        c.click();
        break;
      }
    }
  }
}

/** 图片加载中、画布被清空等过渡状态，不能当作“已换卷” */
export const isTransientFingerprint = (fp: string) => !fp || fp.includes('#loading');

export type ChangeState = 'none' | 'partial' | 'full';

/**
 * 判断换卷进度：
 * - none：还没变、或有图片在加载 / 被清空（过渡状态）
 * - full：图片数量与之前一致，且每一张都和之前对应位置的那张不同
 *   （参考第三方阅卷扩展：只换了第一张、后几张还是旧的，说明还在逐张加载中）；
 *   数量变了（这份学生页数不同）则全部加载完且整体不同即算 full
 * - partial：全部加载完，但只有一部分变了。可能还在逐张加载，
 *   也可能两位学生恰好有一页完全相同（例如都是空白的第二页）
 */
export function changeState(before: string[], now: string[]): ChangeState {
  if (!now.length || now.some(isTransientFingerprint)) return 'none';
  if (now.length !== before.length) return now.join('|') !== before.join('|') ? 'full' : 'none';
  const changed = now.filter((fp, i) => fp !== before[i]).length;
  if (changed === 0) return 'none';
  return changed === now.length ? 'full' : 'partial';
}

const POLL_MS = 200;
/** partial 状态需要保持不变这么久才接受，给逐张加载的平台留出时间 */
const PARTIAL_SETTLE_MS = 2000;

/**
 * 轮询等待换卷完成。full 状态连续两次一致（图片已画完）即成功；
 * partial 状态需保持不变 PARTIAL_SETTLE_MS 才接受。
 * 超时返回 false（可能已经阅完，或平台需要人工操作）。
 */
export async function waitForNext(cfg: AdapterConfig, before: string[], signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + cfg.nextTimeoutMs;
  let candidate = '';
  let since = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    await sleep(POLL_MS);
    const now = fingerprintParts(cfg);
    const state = changeState(before, now);
    if (state === 'none') {
      candidate = '';
      continue;
    }
    const joined = now.join('|');
    if (joined !== candidate) {
      candidate = joined;
      since = Date.now();
      continue;
    }
    if (state === 'full' || Date.now() - since >= PARTIAL_SETTLE_MS) return true;
  }
  return false;
}
