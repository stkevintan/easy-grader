/**
 * 点选适配向导：一步步让用户点出答卷图片、给分方式、提交按钮、考试名与题号，
 * 生成 AdapterConfig。每一步都可以跳过（考试名/题号可手填）。
 */
import type { AdapterConfig, PicType } from '../shared/adapter-config';
import { backgroundUrl } from './capture';
import { groupSelector, readText, uniqueSelector } from './dom';
import { closestWhere, observeInput, pickElement } from './picker';

export type WizardStep =
  | { kind: 'info'; text: string }
  | { kind: 'error'; text: string };

/** 判断点到的元素能当哪种答卷来源 */
export function detectPicType(el: HTMLElement): { el: HTMLElement; type: PicType } | null {
  const img = closestWhere(el, (e) => e instanceof HTMLImageElement, 2);
  if (img) return { el: img, type: 'img' };
  const canvas = closestWhere(el, (e) => e instanceof HTMLCanvasElement, 2);
  if (canvas) return { el: canvas, type: 'canvas' };
  const bgEl = closestWhere(el, (e) => !!backgroundUrl(e), 3);
  if (bgEl) return { el: bgEl, type: 'background' };
  // 再看看它里面是否只有一张大图/一块画布
  const inner = el.querySelector<HTMLElement>('img, canvas');
  if (inner) return { el: inner, type: inner instanceof HTMLImageElement ? 'img' : 'canvas' };
  return null;
}

export function emptyConfig(): AdapterConfig {
  return {
    version: 1,
    pics: { selectors: [], type: 'img', multiple: false },
    scoreMode: 'input',
    scoreInput: { selectors: [] },
    scoreButtons: { selectors: [], clickType: 'click' },
    submit: { selectors: [], clickType: 'click' },
    confirm: { selectors: [] },
    examTitle: { selectors: [] },
    questionNo: { selectors: [] },
    nextTimeoutMs: 8000,
    submitDelayMs: 300,
  };
}

/** 第 1 步：答卷图片。返回 null 表示取消 */
export async function pickPics(cfg: AdapterConfig, asRegion: boolean): Promise<string | null> {
  const el = await pickElement({
    hint: asRegion ? '点击答卷所在的区域（将对该区域截图）' : '点击学生答卷图片',
    resolve: (e) => (asRegion ? e : detectPicType(e)?.el ?? e),
    accept: (e) => {
      const r = e.getBoundingClientRect();
      if (r.width < 80 || r.height < 40) return '这个元素太小，不像答卷';
      if (!asRegion && !detectPicType(e)) return '这里没有图片/画布，可改用「区域截图」';
      return true;
    },
  });
  if (!el) return null;
  const type: PicType = asRegion ? 'region' : detectPicType(el)!.type;
  const sel = uniqueSelector(el);
  // 同一选择器去掉序号后如果命中多个同类元素（多页答卷），提示用户
  const group = groupSelector(el);
  const many = (() => {
    try {
      return document.querySelectorAll(group).length;
    } catch {
      return 1;
    }
  })();
  cfg.pics = { selectors: many > 1 ? [group] : [sel], type, multiple: many > 1 };
  return many > 1 ? `已选择答卷（${type}，检测到 ${many} 张，会自动拼接）` : `已选择答卷（${type}）`;
}

/** 第 2 步（输入框模式）：让用户在平台分数框里真实输入一次 */
export async function pickScoreInput(cfg: AdapterConfig): Promise<string | null> {
  const el = await observeInput();
  if (!el) return null;
  cfg.scoreMode = 'input';
  cfg.scoreInput.selectors = [uniqueSelector(el)];
  cfg.scoreButtons.selectors = [];
  return `已记录分数输入框：${cfg.scoreInput.selectors[0]}`;
}

/** 第 2 步（打分板模式）：点任意一个分数按钮，生成能命中整组按钮的选择器 */
export async function pickScoreButtons(cfg: AdapterConfig): Promise<string | null> {
  const el = await pickElement({
    hint: '点击打分板上的任意一个分数按钮（不会真的给分）',
    resolve: (e) => closestWhere(e, (n) => n.tagName === 'BUTTON' || n.getAttribute('role') === 'button' || /\d/.test(readText(n)), 3) ?? e,
    accept: (e) => (/^\s*(\d+(\.\d+)?\s*分?|满分)\s*$/.test(readText(e)) ? true : '请点击写着分数的按钮'),
  });
  if (!el) return null;
  const sel = groupSelector(el);
  const count = document.querySelectorAll(sel).length;
  cfg.scoreMode = 'buttons';
  cfg.scoreButtons.selectors = [sel];
  cfg.scoreInput.selectors = [];
  return `已记录打分板（${count} 个按钮）`;
}

/** 第 3 步：提交按钮（可跳过：平台给分后自动提交） */
export async function pickSubmit(cfg: AdapterConfig): Promise<string | null> {
  const el = await pickElement({
    hint: '点击平台的「提交 / 下一份」按钮（不会真的提交）',
    resolve: (e) => closestWhere(e, (n) => n.tagName === 'BUTTON' || n.tagName === 'A' || n.getAttribute('role') === 'button', 4) ?? e,
  });
  if (!el) return null;
  cfg.submit.selectors = [uniqueSelector(el)];
  return `已记录提交按钮：「${readText(el).slice(0, 20)}」`;
}

/** 第 4 步：考试名 / 题号 / 满分（点选页面文字，或手填） */
export async function pickText(cfg: AdapterConfig, field: 'examTitle' | 'questionNo' | 'maxScore'): Promise<string | null> {
  const labels = { examTitle: '考试名称', questionNo: '题号', maxScore: '满分' };
  const el = await pickElement({
    hint: `点击页面上显示「${labels[field]}」的文字`,
    accept: (e) => (readText(e) ? (readText(e).length > 120 ? '这段文字太长，请点更具体的位置' : true) : '这里没有文字'),
  });
  if (!el) return null;
  const text = readText(el);
  const regex = field === 'maxScore' || (field === 'questionNo' && /\d/.test(text) && text.length > 6) ? '(\\d+(?:\\.\\d+)?)' : undefined;
  cfg[field] = { selectors: [uniqueSelector(el)], ...(regex ? { regex } : {}) };
  return `已记录${labels[field]}：${text.slice(0, 40)}`;
}
