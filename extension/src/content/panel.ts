/**
 * Panel: Shadow DOM 宿主 + 半自动轮询器。
 *
 * 渲染全部交给 Preact（PanelApp）；这个类只负责：
 *   1. 创建/销毁 closed shadow root
 *   2. 管理拖动和最小化
 *   3. 半自动轮询（1 秒检测换卷，只在「半自动」模式下触发评分）
 *   4. E2E _test 钩子（保持 DOM id 不变）
 */
import { h, render } from 'preact';
import { PANEL_HOST_ID } from './dom';
import { cancelPick } from './picker';
import { PANEL_CSS } from './panel.css';
import { PanelApp } from './panel/PanelApp';
import {
  init, stopAuto, maybeAutoJudge, isAuto,
} from './panel/controller';
import {
  sessionCount, preset, state, user, isPicking, mode, autoPaused, autoConfirmPending,
} from './panel/store';

export class Panel {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private appEl: HTMLElement | null = null;
  private judgeWatcher: ReturnType<typeof setInterval> | null = null;
  private headerTimer: ReturnType<typeof setInterval> | null = null;
  private titleEl: HTMLElement | null = null;
  private creditsEl: HTMLElement | null = null;

  get isOpen() { return this.host !== null; }

  async open() {
    if (this.host) return;

    // Shadow DOM shell
    document.getElementById(PANEL_HOST_ID)?.remove();
    const host = document.createElement('div') as HTMLDivElement;
    host.id = PANEL_HOST_ID;
    this.host = host;
    const root = host.attachShadow({ mode: 'closed' });
    this.root = root;

    root.append(Object.assign(document.createElement('style'), { textContent: PANEL_CSS }));

    // 标题栏（不走 Preact 管理）
    const titleEl = document.createElement('b');
    titleEl.textContent = 'Easy Grader';
    this.titleEl = titleEl;
    const creditsEl = document.createElement('span');
    creditsEl.className = 'credits';
    this.creditsEl = creditsEl;
    const minBtn = document.createElement('button');
    minBtn.className = 'icon'; minBtn.title = '收起'; minBtn.setAttribute('aria-label', '收起面板'); minBtn.textContent = '–';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon'; closeBtn.title = '关闭'; closeBtn.setAttribute('aria-label', '关闭面板'); closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.close());
    const head = document.createElement('div');
    head.className = 'head';
    head.append(titleEl, creditsEl, minBtn, closeBtn);

    minBtn.addEventListener('click', () => {
      panel.classList.toggle('min');
      minBtn.textContent = panel.classList.contains('min') ? '+' : '–';
    });

    // Preact 挂载点
    const appEl = document.createElement('div');
    appEl.className = 'body';
    this.appEl = appEl;

    const panel = document.createElement('section');
    panel.className = 'panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Easy Grader 阅卷助手');
    panel.append(head, appEl);

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
    head.addEventListener('pointerup', () => { drag = null; });

    // 更新标题栏（信号 → 非 Preact DOM）
    this.headerTimer = setInterval(() => this.updateHeader(), 300);

    // 挂载 Preact
    render(h(PanelApp, null), appEl);

    // 初始化状态
    await init();
    if (this.host) this.startJudgeWatcher();
  }

  private updateHeader() {
    if (this.creditsEl) {
      this.creditsEl.textContent = user.value
        ? `${user.value.username} · 剩余 ${user.value.credits} 次`
        : '';
    }
    if (this.titleEl) this.titleEl.textContent = isAuto.value ? 'Easy Grader · 全自动阅卷中' : mode.value === 'semi' ? 'Easy Grader · 半自动' : mode.value === 'auto' ? 'Easy Grader · 全自动已暂停' : 'Easy Grader';
    // Reflect picking state on the .panel section so CSS .panel.picking works
    const panelEl = this.root?.querySelector('section');
    if (panelEl) panelEl.classList.toggle('picking', isPicking.value);
  }

  close() {
    stopAuto();
    // 阅卷模式只在本次打开期间有效：关闭面板回到手动
    mode.value = 'manual';
    autoPaused.value = false;
    autoConfirmPending.value = false;
    this.stopJudgeWatcher();
    if (this.headerTimer) { clearInterval(this.headerTimer); this.headerTimer = null; }
    cancelPick();
    if (this.appEl) { render(null, this.appEl); this.appEl = null; }
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.titleEl = null;
    this.creditsEl = null;
  }

  toggle() {
    if (this.host) this.close();
    else void this.open();
  }

  status() {
    return {
      open: this.isOpen,
      view: state.value.view,
      adapted: !!preset.value,
      auto: isAuto.value,
      mode: mode.value,
      count: sessionCount.value,
    };
  }

  /**
   * E2E テスト钩子（Shadow DOM は closed，测试只能通过这里访问面板内容）
   * _test.fill 会派发 input 事件，受控表单才能更新 signal。
   */
  readonly _test = {
    text: () => this.appEl?.textContent ?? '',
    click: (label: string, n = 0) => {
      const btns = Array.from(this.root?.querySelectorAll('button') ?? [])
        .filter((b) => b.textContent?.trim() === label && !(b as HTMLButtonElement).disabled);
      (btns[n] as HTMLButtonElement | undefined)?.click();
      return !!btns[n];
    },
    fill: (values: Record<string, string>) => {
      for (const [id, v] of Object.entries(values)) {
        const el = this.root?.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
        if (el) {
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    },
  };

  // ---------- 半自動轮询 ----------

  private startJudgeWatcher() {
    if (this.judgeWatcher) return;
    this.judgeWatcher = setInterval(() => maybeAutoJudge(), 1000);
  }

  private stopJudgeWatcher() {
    if (this.judgeWatcher) clearInterval(this.judgeWatcher);
    this.judgeWatcher = null;
  }
}
