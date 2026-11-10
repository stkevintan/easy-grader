/** 极简 DOM 构建工具（不引入框架，控制注入体积）+ Shadow DOM 宿主 */
import { PANEL_HOST_ID } from './dom';
import { PANEL_CSS } from './panel.css';

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** h('button', { class: 'btn', onclick: fn }, '文字') */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function msg(kind: 'info' | 'ok' | 'warn' | 'error', text: string) {
  return h('div', { class: `msg ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
}

export interface PanelShell {
  root: ShadowRoot;
  panel: HTMLElement;
  title: HTMLElement;
  credits: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  destroy(): void;
}

export function createShell(onClose: () => void): PanelShell {
  document.getElementById(PANEL_HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  root.append(h('style', {}, PANEL_CSS));

  const title = h('b', {}, 'Easy Grader');
  const credits = h('span', { class: 'credits' });
  const minBtn = h('button', { class: 'icon', title: '收起', 'aria-label': '收起面板' }, '–');
  const closeBtn = h('button', { class: 'icon', title: '关闭', 'aria-label': '关闭面板', onclick: () => onClose() }, '×');
  const head = h('div', { class: 'head' }, title, credits, minBtn, closeBtn);
  const body = h('div', { class: 'body' });
  const foot = h('div', { class: 'foot' });
  const panel = h('section', { class: 'panel', role: 'dialog', 'aria-label': 'Easy Grader 阅卷助手' }, head, body, foot);
  minBtn.addEventListener('click', () => {
    panel.classList.toggle('min');
    minBtn.textContent = panel.classList.contains('min') ? '+' : '–';
  });
  root.append(panel);
  document.documentElement.append(host);

  // 拖动
  let drag: { x: number; y: number; r: number; b: number } | null = null;
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const rect = panel.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, r: window.innerWidth - rect.right, b: window.innerHeight - rect.bottom };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = Math.max(0, Math.min(window.innerWidth - 120, drag.r - (e.clientX - drag.x)));
    const b = Math.max(0, Math.min(window.innerHeight - 48, drag.b - (e.clientY - drag.y)));
    Object.assign(panel.style, { right: `${r}px`, bottom: `${b}px` });
  });
  head.addEventListener('pointerup', () => (drag = null));

  return { root, panel, title, credits, body, foot, destroy: () => host.remove() };
}
