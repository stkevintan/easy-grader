/**
 * 阅卷面板与状态机：
 *
 *   LOGIN ─► ADAPT ─► TASK ─► READY ─► JUDGING ─► RESULT ─(提交)─► WAIT_NEXT ─► READY …
 *                                         │                      │
 *                                         └──── ERROR / PAUSED ◄─┘
 *
 * 默认半自动：每份答卷都由老师确认分数后才写入、提交。
 * 可选「半自动判题」：换到新答卷自动请求建议分，但写入和提交仍需老师操作。
 * 自动连续模式需手动开启并二次确认；遇到低置信度、写分校验失败、换卷超时都会自动暂停。
 */
import type { AdapterConfig } from '../shared/adapter-config';
import type { GradingInfo, Preset, PublicUser, Settings, TaskInfo, TaskInput } from '../shared/protocol';
import { bg } from '../shared/protocol';
import { AdapterError, confirmUnchanged, fingerprint, fingerprintParts, isTransientFingerprint, readPaperInfo, rejectText, setScore, submit, typeScore, verifyScore, waitForNext, waitRejectChange } from './adapter';
import { captureAnswer } from './capture';
import { cancelPick } from './picker';
import { createShell, h, msg, PanelShell } from './ui';
import { emptyConfig, pickPics, pickScoreButtons, pickScoreInput, pickSubmit, pickText } from './wizard';

type View = 'login' | 'adapt' | 'task' | 'ready' | 'judging' | 'result' | 'waiting';

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Panel {
  private shell: PanelShell | null = null;
  private view: View = 'login';
  private user: PublicUser | null = null;
  private settings!: Settings;
  private subjects: string[] = ['语文'];
  private preset: Preset | null = null;
  private config: AdapterConfig | null = null;
  private draft: AdapterConfig = emptyConfig();
  private task: TaskInfo | null = null;
  private result: GradingInfo | null = null;
  private notice: { kind: 'info' | 'ok' | 'warn' | 'error'; text: string } | null = null;
  private auto = false;
  private abort: AbortController | null = null;
  private sessionCount = 0;
  private lastFingerprint = '';
  /** 评分时实际抓到的答卷图片，用于判断写分前页面是不是真的换卷了 */
  private lastImage = '';
  /** 半自动判题：定时检查页面是否换了答卷 */
  private judgeWatcher: ReturnType<typeof setInterval> | null = null;
  private judgeCandidate = '';
  private judgeCandidateAt = 0;
  /** 已经自动判过（含失败）的指纹，避免同一条答卷反复触发 */
  private autoAttempted = '';

  get isOpen() {
    return this.shell !== null;
  }

  async open() {
    if (this.shell) return;
    this.shell = createShell(() => this.close());
    this.settings = await bg<Settings>({ cmd: 'settings.get' });
    await this.refreshUser();
    if (this.user) await this.loadAdapter();
    this.render();
    this.startJudgeWatcher();
  }

  close() {
    this.stopAuto();
    this.stopJudgeWatcher();
    cancelPick();
    this.shell?.destroy();
    this.shell = null;
  }

  toggle() {
    if (this.shell) this.close();
    else void this.open();
  }

  status() {
    return { open: this.isOpen, view: this.view, adapted: !!this.config, auto: this.auto, count: this.sessionCount };
  }

  /**
   * 端到端测试钩子。面板是 closed shadow root，测试只能在内容脚本的隔离世界里操作它；
   * 页面脚本访问不到这个对象，因此不会给阅卷页面带来额外能力。
   */
  readonly _test = {
    text: () => this.shell?.panel.innerText ?? '',
    /** 点击文字为 label 的第 n 个可用按钮。不等待结果（按钮可能触发长时间的点选流程） */
    click: (label: string, n = 0) => {
      const btn = Array.from(this.shell?.panel.querySelectorAll('button') ?? []).filter((b) => b.textContent?.trim() === label && !b.disabled)[n];
      btn?.click();
      return !!btn;
    },
    fill: (values: Record<string, string>) => {
      for (const [id, v] of Object.entries(values)) {
        const el = this.shell?.root.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
        if (el) el.value = v;
      }
    },
  };

  // ---------- 数据 ----------

  private async refreshUser() {
    const r = await bg<{ user: PublicUser | null }>({ cmd: 'auth.status' }).catch(() => ({ user: null }));
    this.user = r.user;
    if (!this.user) this.view = 'login';
  }

  private async loadAdapter() {
    try {
      const r = await bg<{ preset: Preset | null }>({ cmd: 'adapter.resolve', host: location.host, path: location.pathname });
      this.preset = r.preset;
      this.config = r.preset?.config ?? null;
    } catch (e) {
      this.setNotice('error', errText(e));
    }
    try {
      this.subjects = (await bg<{ subjects: string[] }>({ cmd: 'meta.get' })).subjects;
    } catch {
      /* 用默认学科 */
    }
    this.view = this.config ? 'task' : 'adapt';
    if (this.config) await this.lookupTask();
  }

  private async lookupTask() {
    if (!this.config) return;
    const info = readPaperInfo(this.config);
    if (!info.examTitle || !info.questionNo) return;
    try {
      const r = await bg<{ task: TaskInfo | null }>({
        cmd: 'task.lookup',
        platformHost: location.host,
        exam: info.examTitle,
        q_index: info.questionNo,
      });
      if (r.task) {
        this.task = r.task;
        this.view = 'ready';
        this.setNotice('info', '已载入这道题上次的评分设置，可直接开始；需要修改请点「题目设置」');
      }
    } catch {
      /* 找不到就留在设置页 */
    }
  }

  private setNotice(kind: 'info' | 'ok' | 'warn' | 'error', text: string) {
    this.notice = { kind, text };
  }

  private go(view: View) {
    this.view = view;
    this.render();
  }

  // ---------- 渲染 ----------

  private render() {
    const s = this.shell;
    if (!s) return;
    s.credits.textContent = this.user ? `${this.user.username} · 剩余 ${this.user.credits} 次` : '';
    s.title.textContent = this.auto ? 'Easy Grader · 自动阅卷中' : 'Easy Grader';
    s.body.replaceChildren();
    s.foot.replaceChildren();
    s.foot.className = 'foot';
    if (this.notice) s.body.append(msg(this.notice.kind, this.notice.text));
    const views: Record<View, () => void> = {
      login: () => this.renderLogin(s),
      adapt: () => this.renderAdapt(s),
      task: () => this.renderTask(s),
      ready: () => this.renderReady(s),
      judging: () => this.renderJudging(s),
      result: () => this.renderResult(s),
      waiting: () => this.renderWaiting(s),
    };
    views[this.view]();
  }

  private renderLogin(s: PanelShell) {
    s.body.append(h('p', { class: 'muted' }, '请先在浏览器工具栏点击 Easy Grader 图标登录，登录后回到这里点「刷新」。'));
    if (__DEV__) s.body.append(h('p', { class: 'muted' }, `服务端（开发版）：${this.settings.serverUrl}`));
    s.foot.append(
      h('button', {
        class: 'btn primary grow',
        onclick: async () => {
          this.notice = null;
          await this.refreshUser();
          if (this.user) await this.loadAdapter();
          this.render();
        },
      }, '刷新'),
    );
  }
  // ---------- 适配向导 ----------

  private renderAdapt(s: PanelShell) {
    const d = this.draft;
    const hasScore = d.scoreMode === 'input' ? d.scoreInput.selectors.length > 0 : d.scoreButtons.selectors.length > 0;
    const step = (name: string, done: boolean, state: string, ...actions: HTMLElement[]) =>
      h('li', {}, h('span', { class: 'name' }, name), h('span', { class: `state${done ? ' done' : ''}`, title: state }, state), ...actions);
    // 等待用户在页面上点选/输入时，把面板收成一条，避免挡住阅卷平台的控件
    const run = (fn: () => Promise<string | null>, hint?: string) => async () => {
      if (hint) this.setNotice('info', hint);
      else this.notice = null;
      this.render();
      this.shell?.panel.classList.add('picking');
      try {
        const r = await fn();
        this.setNotice(r ? 'ok' : 'warn', r ?? '已取消');
      } catch (e) {
        this.setNotice('error', errText(e));
      } finally {
        this.shell?.panel.classList.remove('picking');
      }
      this.render();
    };
    const small = (label: string, onclick: () => void) => h('button', { class: 'btn', onclick }, label);

    s.body.append(
      h('h4', {}, this.preset ? `重新适配（当前：${this.preset.name}）` : '第一次使用：适配这个阅卷页面'),
      h('p', { class: 'muted' }, '按顺序点出页面上的几个位置。点选时不会真的给分或提交。'),
      h(
        'ol',
        { class: 'steps' },
        step(
          '1. 答卷图片',
          d.pics.selectors.length > 0,
          d.pics.selectors.length ? `${d.pics.type}${d.pics.multiple ? ' ×多张' : ''}` : '未选择',
          small('点选', run(() => pickPics(d, false))),
          small('区域截图', run(() => pickPics(d, true))),
        ),
        step(
          '2. 给分位置',
          hasScore,
          hasScore ? (d.scoreMode === 'input' ? '输入框' : '打分板') : '未选择',
          small('输入框', run(() => pickScoreInput(d), '请在阅卷平台的分数框里用键盘输入任意一个分数（先别提交）')),
          small('打分板', run(() => pickScoreButtons(d))),
        ),
        step(
          '3. 提交按钮',
          d.submit.selectors.length > 0,
          d.submit.selectors.length ? '已选择' : '未选择（给分后自动提交可跳过）',
          small('点选', run(() => pickSubmit(d))),
        ),
        step('4. 考试名称', !!(d.examTitle.selectors.length || d.examTitle.fixed), d.examTitle.fixed || (d.examTitle.selectors.length ? '已选择' : '未选择'), small('点选', run(() => pickText(d, 'examTitle')))),
        step('5. 题号', !!(d.questionNo.selectors.length || d.questionNo.fixed), d.questionNo.fixed || (d.questionNo.selectors.length ? '已选择' : '未选择'), small('点选', run(() => pickText(d, 'questionNo')))),
        step('6. 满分（可选）', !!d.maxScore?.selectors.length, d.maxScore?.selectors.length ? '已选择' : '可跳过', small('点选', run(() => pickText(d, 'maxScore')))),
      ),
      h('label', { for: 'eg-exam-fixed' }, '页面上没有考试名称？直接填写：'),
      h('input', {
        id: 'eg-exam-fixed',
        placeholder: '例如：高二期中语文',
        value: d.examTitle.fixed ?? '',
        oninput: (e: Event) => {
          d.examTitle.fixed = (e.target as HTMLInputElement).value.trim() || undefined;
        },
      }),
      h('label', { for: 'eg-q-fixed' }, '页面上没有题号？直接填写：'),
      h('input', {
        id: 'eg-q-fixed',
        placeholder: '例如：17',
        value: d.questionNo.fixed ?? '',
        oninput: (e: Event) => {
          d.questionNo.fixed = (e.target as HTMLInputElement).value.trim() || undefined;
        },
      }),
    );

    const ready = d.pics.selectors.length > 0 && hasScore;
    s.foot.append(
      h('button', { class: 'btn', onclick: () => this.testDraft() }, '试读一次'),
      h('button', { class: 'btn primary grow', disabled: !ready, onclick: () => this.saveDraft() }, '保存适配'),
    );
    if (this.config) s.foot.append(h('button', { class: 'btn', onclick: () => this.go(this.task ? 'ready' : 'task') }, '返回'));
  }

  /** 不提交任何东西，只验证能读到图片和题目信息 */
  private async testDraft() {
    try {
      const img = await captureAnswer(this.draft.pics);
      const info = readPaperInfo(this.draft);
      const kb = Math.round((img.length * 3) / 4 / 1024);
      this.setNotice(
        'ok',
        `读取成功：答卷图片约 ${kb}KB\n考试：${info.examTitle || '（未读到）'}\n题号：${info.questionNo || '（未读到）'}${info.maxScore ? `\n满分：${info.maxScore}` : ''}`,
      );
    } catch (e) {
      this.setNotice('error', `试读失败：${errText(e)}`);
    }
    this.render();
  }

  private async saveDraft() {
    try {
      const p = await bg<Preset>({
        cmd: 'adapter.save',
        name: `${document.title.slice(0, 40) || location.host}`,
        hostPattern: location.hostname,
        pathPattern: '',
        config: this.draft,
      });
      this.preset = p;
      this.config = p.config;
      this.setNotice('ok', '适配已保存，下次打开这个平台会自动使用');
      await this.lookupTask();
      if (!this.task) this.view = 'task';
    } catch (e) {
      this.setNotice('error', errText(e));
    }
    this.render();
  }

  // ---------- 题目设置 ----------

  private renderTask(s: PanelShell) {
    const info = this.config ? readPaperInfo(this.config) : { examTitle: '', questionNo: '', maxScore: null };
    const t = this.task;
    const content = t?.question.content ?? {};
    const field = (id: string, label: string, el: HTMLElement) => [h('label', { for: id }, label), el];
    const subject = h('select', { id: 'eg-subject' }, ...this.subjects.map((x) => h('option', { value: x }, x)));
    subject.value = t?.exam.subject ?? this.subjects[0];
    const exam = h('input', { id: 'eg-exam', value: t?.exam.exam ?? info.examTitle, required: true, maxlength: 200 });
    const qno = h('input', { id: 'eg-qno', value: t?.exam.q_index ?? info.questionNo, required: true, maxlength: 100 });
    const max = h('input', { id: 'eg-max', type: 'number', min: 0.5, max: 200, step: 0.5, value: content.score ?? info.maxScore ?? '', required: true });
    const step = h('select', { id: 'eg-step' }, ...[1, 0.5, 2, 5].map((x) => h('option', { value: x }, `${x} 分`)));
    step.value = String(t?.scoreStep ?? 1);
    const qtype = h('input', { id: 'eg-qtype', value: t?.question.type ?? '', placeholder: '如：阅读理解 / 作文 / 古诗文翻译', maxlength: 50 });
    const qtext = h('textarea', { id: 'eg-qtext', maxlength: 8000, placeholder: '题干（可选，建议填写）' });
    qtext.value = String(content.title ?? '');
    const ref = h('textarea', { id: 'eg-ref', maxlength: 8000, placeholder: '参考答案' });
    ref.value = String(content.reference ?? '');
    const rubric = h('textarea', { id: 'eg-rubric', maxlength: 8000, placeholder: '评分细则，例如：答出“思念外婆”得 2 分；答出“怀念乡村生活”得 2 分……' });
    const majorKey = t?.majorInput.key ?? 'command';
    // 评分依据可能指向题干/参考答案；编辑这些字段时同步评分依据，避免保存时用旧值覆盖
    rubric.value = String(content[majorKey] ?? t?.majorInput.content ?? content.command ?? '');
    qtext.addEventListener('input', () => {
      if (majorKey === 'title') rubric.value = qtext.value;
    });
    ref.addEventListener('input', () => {
      if (majorKey === 'reference') rubric.value = ref.value;
    });
    rubric.addEventListener('input', () => {
      if (majorKey === 'title') qtext.value = rubric.value;
      else if (majorKey === 'reference') ref.value = rubric.value;
    });

    s.body.append(
      h('h4', {}, '题目设置'),
      h('p', { class: 'muted' }, '评分质量主要取决于参考答案和评分细则，写得越具体越准。'),
      h('div', { class: 'row' }, h('div', {}, ...field('eg-exam', '考试名称', exam)), h('div', {}, ...field('eg-qno', '题号', qno))),
      h('div', { class: 'row' }, h('div', {}, ...field('eg-subject', '学科', subject)), h('div', {}, ...field('eg-max', '满分', max)), h('div', {}, ...field('eg-step', '步长', step))),
      ...field('eg-qtype', '题型（可选）', qtype),
      ...field('eg-qtext', '题干', qtext),
      ...field('eg-ref', '参考答案', ref),
      ...field('eg-rubric', '评分细则', rubric),
    );

    s.foot.append(
      h('button', {
        class: 'btn primary grow',
        onclick: async () => {
          const maxScore = Number(max.value);
          if (!exam.value.trim() || !qno.value.trim()) return this.fail('请填写考试名称和题号');
          if (!(maxScore > 0)) return this.fail('请填写满分');
          // 评分依据不是 command 时，command 里的给分规则会单独保留；
          // 清空参考答案不应连带阻止保存
          const preservedCommand = majorKey !== 'command' ? String(content.command ?? '').trim() : '';
          if (!ref.value.trim() && !rubric.value.trim() && !preservedCommand) {
            return this.fail('参考答案和评分细则至少填一项');
          }
          try {
            // 表单只覆盖它展示的字段；resource/target/keywords/extra 等要保留
            const prevQuestion = this.task?.question;
            const prevMajor = this.task?.majorInput;
            const input: TaskInput = {
              platformHost: location.host,
              scoreStep: Number(step.value),
              exam: { exam: exam.value.trim(), subject: subject.value, q_index: qno.value.trim() },
              question: {
                type: qtype.value.trim(),
                content: {
                  ...(prevQuestion?.content ?? {}),
                  score: maxScore,
                  title: qtext.value.trim(),
                  reference: ref.value.trim(),
                  ...(majorKey === 'command' ? { command: rubric.value.trim() } : {}),
                },
                ...(prevQuestion?.extra ? { extra: prevQuestion.extra } : {}),
              },
              majorInput: {
                key: majorKey,
                name: prevMajor?.name ?? '评分细则',
                content: rubric.value.trim(),
              },
            };
            this.task = await bg<TaskInfo>({ cmd: 'task.upsert', task: input });
            // 评分标准变了，当前这份需要重新判
            this.lastFingerprint = '';
            this.autoAttempted = '';
            this.setNotice('ok', '题目设置已保存');
            this.go('ready');
          } catch (e) {
            this.fail(errText(e));
          }
        },
      }, '保存并开始'),
      h('button', { class: 'btn', onclick: () => this.startAdapt() }, '重新适配'),
    );
    if (this.task) s.foot.append(h('button', { class: 'btn', onclick: () => this.go('ready') }, '返回'));
  }

  private fail(text: string) {
    this.setNotice('error', text);
    this.render();
  }

  private startAdapt() {
    this.draft = this.config ? structuredClone(this.config) : emptyConfig();
    this.notice = null;
    this.go('adapt');
  }

  // ---------- 阅卷 ----------

  private renderReady(s: PanelShell) {
    const t = this.task!;
    s.foot.classList.add('stack');
    s.body.append(
      h('dl', { class: 'kv' },
        h('dt', {}, '考试'), h('dd', { title: t.exam.exam }, t.exam.exam),
        h('dt', {}, '题号'), h('dd', {}, `${t.exam.q_index}（${t.exam.subject}，满分 ${fmt(Number(t.question.content.score ?? 0))}）`),
        h('dt', {}, '本次'), h('dd', {}, `已阅 ${this.sessionCount} 份`),
      ),
      h('p', { class: 'muted' }, this.settings.autoJudge
        ? '半自动判题已开启：换到新答卷会自动获取建议分，不会写入或提交。'
        : '「获取建议分」只会给出分数和理由，确认后才写入平台并提交。'),
    );
    s.foot.append(
      h('button', { class: 'btn primary grow', onclick: () => this.judgeOnce() }, '获取建议分'),
      h('button', { class: 'btn', onclick: () => this.confirmAuto() }, '自动连续阅卷'),
      h('button', { class: 'btn', onclick: () => this.toggleAutoJudge() }, this.settings.autoJudge ? '半自动：开' : '半自动判题'),
      h('button', { class: 'btn', onclick: () => this.go('task') }, '题目设置'),
    );
  }

  private renderJudging(s: PanelShell) {
    s.body.append(msg('info', '正在读取答卷并请求评分…'));
    s.foot.append(h('button', { class: 'btn grow', onclick: () => this.stopAuto('已停止') }, this.auto ? '停止自动阅卷' : '取消'));
  }

  private renderWaiting(s: PanelShell) {
    s.body.append(msg('info', '已提交，等待平台切换到下一份答卷…'));
    s.foot.append(h('button', { class: 'btn grow', onclick: () => this.stopAuto('已停止') }, this.auto ? '停止自动阅卷' : '取消'));
  }

  private renderResult(s: PanelShell) {
    const r = this.result!;
    const confClass = r.confidence >= 0.8 ? 'high' : r.confidence >= 0.6 ? 'mid' : 'low';
    const scoreInput = h('input', {
      type: 'number',
      min: 0,
      max: r.maxScore,
      step: this.task?.scoreStep ?? 1,
      value: r.score,
      'aria-label': '最终分数',
    });
    s.body.append(...[
      h('div', { class: 'score' }, scoreInput, h('span', { class: 'max' }, `/ ${fmt(r.maxScore)}`),
        h('span', { class: `conf ${confClass}`, title: '模型对本次评分的把握程度' }, `置信度 ${Math.round(r.confidence * 100)}%`)),
      r.model === 'mock' ? msg('warn', '服务端未配置模型，当前是 mock 分数，请勿用于真实阅卷') : null,
      r.samples && r.samples.length > 1
        ? h('p', { class: 'muted' }, `多次评分：${r.samples.join(' / ')}${r.scoreSpread ? '（不一致，请重点核对）' : ''}`)
        : null,
      r.cached ? h('p', { class: 'muted' }, '这份答卷之前评过，直接使用上次结果（未扣次数）') : null,
      r.reasons.length ? h('ul', { class: 'reasons' }, ...r.reasons.map((x) => h('li', {}, x))) : r.reason ? h('p', {}, r.reason) : null,
      r.comment ? h('p', {}, r.comment) : null,
      r.ocr ? h('details', {}, h('summary', {}, '识别出的答卷文字'), h('pre', { class: 'ocr' }, r.ocr)) : null,
    ].filter((x) => x !== null) as HTMLElement[]);
    const commit = async (andNext: boolean) => {
      const v = Number(scoreInput.value);
      if (!Number.isFinite(v) || v < 0 || v > r.maxScore) return this.fail(`分数需在 0-${fmt(r.maxScore)} 之间`);
      await this.commitScore(v, andNext, false);
    };
    s.foot.append(
      h('button', { class: 'btn primary grow', onclick: () => commit(true) }, '写入并提交'),
      h('button', { class: 'btn', onclick: () => commit(false) }, '只写入'),
      h('button', { class: 'btn', onclick: () => this.judgeOnce(true) }, '重评'),
      h('button', { class: 'btn', onclick: () => { this.notice = null; this.go('ready'); } }, '放弃'),
    );
    setTimeout(() => scoreInput.focus(), 0);
  }

  /** 读答卷 → 请求评分；返回 null 表示失败（已显示错误） */
  private async judgeOnce(force = false, preCaptured?: string): Promise<GradingInfo | null> {
    if (!this.config || !this.task) return null;
    this.notice = null;
    this.go('judging');
    try {
      // 题号/考试变了说明老师切到了别的题，不能沿用当前任务的评分标准
      const info = readPaperInfo(this.config);
      if (info.questionNo && info.questionNo !== this.task.exam.q_index && !this.config.questionNo.fixed) {
        throw new AdapterError(`页面题号变成了「${info.questionNo}」，与当前任务「${this.task.exam.q_index}」不一致，请到「题目设置」确认`);
      }
      const image = preCaptured ?? (await captureAnswer(this.config.pics));
      this.lastImage = image;
      // 抓完图再记指纹：图片还在加载、画布正被清空时读到的是过渡状态，会让写分校验误判
      this.lastFingerprint = fingerprint(this.config);
      const r = await bg<GradingInfo>({ cmd: 'judge.run', taskId: this.task.taskId, image, force });
      if (this.view !== 'judging') return null; // 期间被取消
      this.result = r;
      if (this.user) this.user.credits = r.balance;
      this.go('result');
      return r;
    } catch (e) {
      this.stopAuto();
      this.setNotice('error', errText(e));
      this.go('ready');
      return null;
    }
  }

  private async commitScore(score: number, andNext: boolean, autoSubmitted: boolean): Promise<boolean> {
    const cfg = this.config!;
    const r = this.result!;
    try {
      // 写分前再确认一次答卷没变，防止把分数写到另一份卷子上
      if (isTransientFingerprint(this.lastFingerprint)) {
        console.warn('[EasyGrader] 评分时答卷指纹处于过渡状态，跳过写分前校验', this.lastFingerprint);
      } else {
        const now = await confirmUnchanged(cfg, this.lastFingerprint);
        if (now !== null) {
          // 指纹可能只是页面重绘引起的抖动，以真正抓到的答卷图片为准
          let image: string;
          try {
            image = await captureAnswer(cfg.pics);
          } catch {
            throw new AdapterError('页面上的答卷已经变了，本次评分作废，请重新获取建议分');
          }
          if (image === this.lastImage) {
            console.warn('[EasyGrader] 指纹变化但答卷图片一致，按原评分写入', { expected: this.lastFingerprint, now });
          } else {
            // 真的换卷了：自动对当前这份重新评分，由老师核对后再写入
            console.warn('[EasyGrader] 答卷已变化，自动重新评分', { expected: this.lastFingerprint, now });
            const again = await this.judgeOnce(false, image);
            if (again) this.setNotice('warn', '页面上的答卷已变化，已自动重新评分，请核对分数后再写入');
            return false;
          }
        }
      }
      setScore(cfg, score, r.maxScore);
      await new Promise((res) => setTimeout(res, 120));
      if (!verifyScore(cfg, score)) throw new AdapterError('分数写入后读回不一致，平台可能拒绝了输入，请手动给分');
      await bg({ cmd: 'record.confirm', gradingId: r.gradingId, modifiedScore: score, isAuto: autoSubmitted }).catch(() => undefined);
      if (!andNext) {
        this.setNotice('ok', `已写入 ${fmt(score)} 分，请在平台上检查后手动提交`);
        this.go('ready');
        return true;
      }
      this.go('waiting');
      const before = fingerprintParts(cfg);
      const rejectBefore = rejectText();
      await submit(cfg);
      // 平台只认真实键盘输入时会拒绝程序化写入，并提示「分数不能为空」：改用键盘事件重写后重新提交
      const rejected = await waitRejectChange(rejectBefore);
      if (rejected) {
        console.warn(`[EasyGrader] 平台拒绝提交：${rejected}，改用键盘输入重写分数`);
        this.setNotice('warn', `平台提示「${rejected}」，正在重写分数…`);
        await typeScore(cfg, score);
        await new Promise((res) => setTimeout(res, 150));
        if (!verifyScore(cfg, score)) throw new AdapterError('分数写入后读回不一致，平台可能拒绝了输入，请手动给分');
        await submit(cfg);
      }
      this.sessionCount += 1;
      const changed = await waitForNext(cfg, before, this.abort?.signal);
      if (!changed) {
        this.stopAuto();
        const stillRejected = rejectText();
        if (stillRejected) {
          this.setNotice('error', `平台提示「${stillRejected}」，这次没有写入成功，请手动给分后继续`);
          this.go('result');
          return false;
        }
        this.setNotice('warn', '提交后答卷没有变化：可能已全部阅完，或平台需要人工操作。');
        this.go('ready');
        return false;
      }
      this.setNotice('ok', `已提交 ${fmt(score)} 分，已切换到下一份`);
      this.go('ready');
      return true;
    } catch (e) {
      this.stopAuto();
      this.setNotice('error', errText(e));
      this.go('result');
      return false;
    }
  }

  // ---------- 自动连续阅卷 ----------

  private confirmAuto() {
    const ok = window.confirm(
      [
        '开启自动连续阅卷后，扩展会自动：读取答卷 → AI 评分 → 写入分数 → 提交 → 下一份。',
        '',
        `· 置信度低于 ${Math.round(this.settings.autoMinConfidence * 100)}% 时会暂停，等你确认`,
        `· 每份之间至少间隔 ${this.settings.autoIntervalMs / 1000} 秒`,
        '· 写分校验失败、换卷超时、额度不足都会自动停止',
        '',
        '请确认：你有权在该平台使用自动化工具，并会对最终分数负责。',
        '确定开启吗？',
      ].join('\n'),
    );
    if (ok) void this.runAuto();
  }

  private async runAuto() {
    this.auto = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    while (this.auto && !signal.aborted) {
      const started = Date.now();
      const r = await this.judgeOnce();
      if (!r || !this.auto) break;
      if (r.confidence < this.settings.autoMinConfidence) {
        this.auto = false;
        this.setNotice('warn', `置信度 ${Math.round(r.confidence * 100)}% 较低，已暂停自动阅卷，请人工确认这一份`);
        this.go('result');
        break;
      }
      const ok = await this.commitScore(r.score, true, true);
      if (!ok || !this.auto) break;
      const wait = this.settings.autoIntervalMs - (Date.now() - started);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }
    this.auto = false;
    this.abort = null;
    this.render();
  }

  private stopAuto(text?: string) {
    const was = this.auto;
    this.auto = false;
    this.abort?.abort();
    this.abort = null;
    if (text && (was || this.view === 'judging' || this.view === 'waiting')) {
      this.setNotice('info', text);
      this.go(this.task ? 'ready' : 'task');
    }
  }

  // ---------- 半自动判题 ----------

  private toggleAutoJudge() {
    void (async () => {
      try {
        const next = !this.settings.autoJudge;
        this.settings = await bg<Settings>({ cmd: 'settings.set', settings: { autoJudge: next } });
        this.judgeCandidate = '';
        this.autoAttempted = '';
        this.setNotice('info', next ? '半自动判题已开启：换到新答卷会自动评分，不会写入或提交' : '半自动判题已关闭');
        this.render();
        if (next) this.maybeAutoJudge();
      } catch (e) {
        this.setNotice('error', errText(e));
        this.render();
      }
    })();
  }

  private startJudgeWatcher() {
    if (this.judgeWatcher) return;
    this.judgeWatcher = setInterval(() => this.maybeAutoJudge(), 1000);
  }

  private stopJudgeWatcher() {
    if (this.judgeWatcher) clearInterval(this.judgeWatcher);
    this.judgeWatcher = null;
    this.judgeCandidate = '';
  }

  /** 页面换到新答卷时自动请求建议分；只评分，绝不写入或提交 */
  private maybeAutoJudge() {
    if (!this.shell || !this.settings?.autoJudge) return;
    if (this.view !== 'ready' || this.auto || !this.config || !this.task) return;
    let fp: string;
    try {
      fp = fingerprint(this.config);
    } catch {
      return;
    }
    if (isTransientFingerprint(fp) || fp === this.lastFingerprint || fp === this.autoAttempted) {
      this.judgeCandidate = '';
      return;
    }
    // 连续两次读到同一指纹才判，给平台留出绘制时间
    const now = Date.now();
    if (fp !== this.judgeCandidate) {
      this.judgeCandidate = fp;
      this.judgeCandidateAt = now;
      return;
    }
    if (now - this.judgeCandidateAt < 700) return;
    this.judgeCandidate = '';
    this.autoAttempted = fp;
    console.info('[EasyGrader] 半自动判题：检测到新答卷');
    void this.judgeOnce();
  }
}
