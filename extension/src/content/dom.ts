/** DOM 工具：选择器查找、文本读取、可靠地写值与点击、选择器生成 */

/** 面板自身的宿主元素 id，所有查找都要排除它 */
export const PANEL_HOST_ID = 'easy-grader-host';

const isOurs = (el: Element) => el.closest(`#${PANEL_HOST_ID}`) !== null;

export function queryAll(selectors: string[], root: ParentNode = document): HTMLElement[] {
  for (const s of selectors) {
    try {
      const found = Array.from(root.querySelectorAll<HTMLElement>(s)).filter((e) => !isOurs(e));
      if (found.length) return found;
    } catch {
      /* 非法选择器：跳过 */
    }
  }
  return [];
}

export const queryOne = (selectors: string[], root?: ParentNode) => queryAll(selectors, root)[0] ?? null;

export function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  // opacity 未设置时某些环境返回空串，按 1 处理
  const opacity = st.opacity === '' ? 1 : Number(st.opacity);
  return st.visibility !== 'hidden' && st.display !== 'none' && !(opacity === 0);
}

export function readText(el: Element | null): string {
  if (!el) return '';
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.trim();
  if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent?.trim() ?? '';
  return ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 用原生 setter 写值，兼容 React/Vue 受控输入框（直接改 .value 不会触发它们的状态更新） */
export function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  el.focus();
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
  el.blur();
}

/** clickType=events：模拟完整的指针事件序列，给只监听 mousedown/pointerup 的平台用 */
export function clickElement(el: HTMLElement, type: 'click' | 'events') {
  if (type === 'click') {
    el.click();
    return;
  }
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

// ---------- 选择器生成 ----------

const cssEscape = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

/** 看起来像自动生成的 class / id（含长数字串、hash、Vue scoped 属性等）不适合做稳定选择器 */
const unstable = (s: string) => /\d{3,}|[a-f0-9]{6,}|^data-v-|^css-|^sc-|^jsx-|--\w{5,}$/i.test(s);

const stableClasses = (el: Element) =>
  Array.from(el.classList)
    .filter((c) => !unstable(c) && c.length < 40)
    .slice(0, 3);

const uniqueIn = (sel: string, el: Element, root: ParentNode = document) => {
  try {
    const list = root.querySelectorAll(sel);
    return list.length === 1 && list[0] === el;
  } catch {
    return false;
  }
};

/** 单个元素自身的候选片段，越靠前越稳定 */
function selfCandidates(el: Element): string[] {
  const tag = el.tagName.toLowerCase();
  const out: string[] = [];
  if (el.id && !unstable(el.id)) out.push(`#${cssEscape(el.id)}`);
  for (const attr of ['name', 'data-testid', 'data-test', 'aria-label', 'placeholder', 'title', 'role', 'type']) {
    const v = el.getAttribute(attr);
    if (v && v.length < 50 && !/\d{3,}/.test(v)) out.push(`${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`);
  }
  const cls = stableClasses(el);
  if (cls.length) out.push(`${tag}.${cls.map(cssEscape).join('.')}`);
  out.push(tag);
  return out;
}

function nthOfType(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag;
}

/**
 * 为元素生成一个在当前页面唯一命中它的 CSS 选择器：
 * 先试元素自身属性；不唯一就向上逐级加祖先限定（祖先优先用 id / 稳定 class），最多 5 层；
 * 最后退回 nth-of-type 路径。
 */
export function uniqueSelector(el: Element): string {
  for (const c of selfCandidates(el)) if (uniqueIn(c, el)) return c;

  // 元素自身最好的片段（不是光秃秃的 tag 就用它，否则用 nth-of-type）
  const tag = el.tagName.toLowerCase();
  const self = selfCandidates(el).find((c) => c !== tag) ?? nthOfType(el);

  // 1) 祖先限定（后代组合符）：#box input.score
  let node: Element | null = el.parentElement;
  for (let depth = 0; node && node !== document.body && depth < 5; depth++, node = node.parentElement) {
    for (const anc of selfCandidates(node).slice(0, -1)) {
      for (const tail of [self, nthOfType(el)]) {
        const sel = `${anc} ${tail}`;
        if (uniqueIn(sel, el)) return sel;
      }
    }
  }

  // 2) 向上拼 nth-of-type 子组合链，直到唯一：div:nth-of-type(2) > input
  let chain = nthOfType(el);
  node = el.parentElement;
  for (let depth = 0; node && node !== document.body && depth < 6; depth++, node = node.parentElement) {
    chain = `${nthOfType(node)} > ${chain}`;
    if (uniqueIn(chain, el)) return chain;
  }
  return fullPath(el);
}

/** 从 body 开始的 nth-of-type 全路径，保证唯一但最脆弱 */
export function fullPath(el: Element): string {
  const parts: string[] = [];
  for (let n: Element | null = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    parts.unshift(nthOfType(n));
  }
  return ['body', ...parts].join(' > ');
}

/**
 * 为一组同类元素（例如打分板上的所有分数按钮）生成一个能同时命中它们的选择器：
 * 以用户点到的那个为样本，取「最近的共同容器 + 样本自身的 tag/class」。
 */
export function groupSelector(sample: Element): string {
  const tag = sample.tagName.toLowerCase();
  const cls = stableClasses(sample);
  const self = cls.length ? `${tag}.${cls.map(cssEscape).join('.')}` : tag;
  let container: Element | null = sample.parentElement;
  for (let depth = 0; container && container !== document.body && depth < 4; depth++, container = container.parentElement) {
    const siblings = container.querySelectorAll(self);
    if (siblings.length >= 2) {
      const containerSel = uniqueSelector(container);
      return `${containerSel} ${self}`;
    }
  }
  return uniqueSelector(sample);
}
