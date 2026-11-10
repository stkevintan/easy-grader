/**
 * 点选器：让用户在阅卷页面上点出某个元素。
 * - 悬停高亮，点击选中（捕获阶段拦截，不会触发页面原有的点击逻辑）
 * - Esc 取消
 * - 面板内的点击不拦截
 */
import { PANEL_HOST_ID } from './dom';

export interface PickOptions {
  /** 提示文字 */
  hint: string;
  /** 只接受满足条件的元素；返回字符串表示拒绝原因 */
  accept?: (el: HTMLElement) => true | string;
  /** 把指针下的元素映射成真正要选的元素（例如点到 img 里的子元素时向上找） */
  resolve?: (el: HTMLElement) => HTMLElement | null;
}

let active: (() => void) | null = null;

export function cancelPick() {
  active?.();
}

export function pickElement(opts: PickOptions): Promise<HTMLElement | null> {
  cancelPick();
  return new Promise((resolvePromise) => {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:3px;transition:all .05s;display:none';
    const tip = document.createElement('div');
    tip.style.cssText =
      'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;background:#1e293b;color:#fff;padding:8px 14px;border-radius:8px;font:14px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;max-width:80vw';
    tip.textContent = `${opts.hint}（Esc 取消）`;
    document.documentElement.append(box, tip);

    let current: HTMLElement | null = null;
    const ours = (e: Event) => (e.target as Element | null)?.closest?.(`#${PANEL_HOST_ID}`) || e.composedPath().some((n) => (n as Element).id === PANEL_HOST_ID);

    const target = (e: MouseEvent): HTMLElement | null => {
      const raw = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!raw || raw === box || raw === tip) return null;
      return opts.resolve ? opts.resolve(raw) : raw;
    };

    const onMove = (e: MouseEvent) => {
      if (ours(e)) {
        box.style.display = 'none';
        return;
      }
      current = target(e);
      if (!current) return;
      const r = current.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      const ok = opts.accept ? opts.accept(current) : true;
      box.style.borderColor = ok === true ? '#2563eb' : '#dc2626';
      tip.textContent = ok === true ? `${opts.hint}（Esc 取消）` : `${ok}（Esc 取消）`;
    };

    const swallow = (e: Event) => {
      if (ours(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    const onClick = (e: MouseEvent) => {
      if (ours(e)) return;
      swallow(e);
      const el = target(e);
      if (!el) return;
      const ok = opts.accept ? opts.accept(el) : true;
      if (ok !== true) {
        tip.textContent = `${ok}（Esc 取消）`;
        return;
      }
      done(el);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        swallow(e);
        done(null);
      }
    };

    const events: [string, EventListener][] = [
      ['mousemove', onMove as EventListener],
      ['click', onClick as EventListener],
      ['mousedown', swallow],
      ['mouseup', swallow],
      ['pointerdown', swallow],
      ['pointerup', swallow],
      ['keydown', onKey as EventListener],
    ];
    events.forEach(([t, h]) => window.addEventListener(t, h, true));

    function done(el: HTMLElement | null) {
      events.forEach(([t, h]) => window.removeEventListener(t, h, true));
      box.remove();
      tip.remove();
      active = null;
      resolvePromise(el);
    }
    active = () => done(null);
  });
}

/**
 * 观察用户在页面上的一次真实输入（不拦截）：用于“请在平台的分数框里手动输入一个分数”。
 * 比点选更可靠：能拿到真正接收键盘输入的那个元素。
 */
export function observeInput(timeoutMs = 120000): Promise<HTMLInputElement | HTMLTextAreaElement | null> {
  cancelPick();
  return new Promise((resolve) => {
    const onInput = (e: Event) => {
      const t = e.target;
      if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && !t.closest(`#${PANEL_HOST_ID}`)) {
        finish(t);
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    document.addEventListener('input', onInput, true);
    function finish(el: HTMLInputElement | HTMLTextAreaElement | null) {
      clearTimeout(timer);
      document.removeEventListener('input', onInput, true);
      active = null;
      resolve(el);
    }
    active = () => finish(null);
  });
}

/** 向上找最近的、满足条件的元素（含自身） */
export function closestWhere(el: HTMLElement | null, pred: (e: HTMLElement) => boolean, maxDepth = 6): HTMLElement | null {
  for (let n = el, d = 0; n && d <= maxDepth; n = n.parentElement, d++) if (pred(n)) return n;
  return null;
}
