/**
 * Panel controller: 评分、提交、自动连续阅卷的异步流程。
 *
 * 只操作 store 信号，不直接改 DOM；组件只需读信号和调这里的函数。
 */
import type { AdapterConfig } from '../../shared/adapter-config';
import type { GradingInfo, TaskInfo } from '../../shared/protocol';
import { bg } from '../../shared/protocol';
import { signal } from '@preact/signals';
import { AdapterError, confirmUnchanged, fingerprint, fingerprintParts, isTransientFingerprint, readPaperInfo, rejectText, setScore, submit, typeScore, verifyScore, waitForNext, waitRejectChange } from '../adapter';
import { captureAnswer } from '../capture';
import {
  autoAttempted, autoConfirmPending, autoPaused, clearNotice, judgeCandidate, lastFingerprint, lastImage, mode, notice,
  preset, sessionCount, setNotice, settings, state, subjects, user,
} from './store';
import { TaskForm } from './forms/task-form';
import type { Mode } from './store';
import { emptyConfig } from '../wizard';

// ---------- 初始化 ----------

export async function init() {
  const s = await bg<import('../../shared/protocol').Settings>({ cmd: 'settings.get' });
  settings.value = s;
  const r = await bg<{ user: import('../../shared/protocol').PublicUser | null }>({ cmd: 'auth.status' }).catch(() => ({ user: null }));
  user.value = r.user;
  if (!user.value) { state.value = { view: 'login' }; return; }
  await loadAdapter();
}

export async function refreshUser() {
  const r = await bg<{ user: import('../../shared/protocol').PublicUser | null }>({ cmd: 'auth.status' }).catch(() => ({ user: null }));
  user.value = r.user;
  if (!user.value) { state.value = { view: 'login' }; return; }
  await loadAdapter();
}

async function loadAdapter() {
  try {
    const r = await bg<{ preset: import('../../shared/protocol').Preset | null }>({ cmd: 'adapter.resolve', host: location.host, path: location.pathname });
    preset.value = r.preset;
  } catch (e) { setNotice('error', errText(e)); }
  try {
    subjects.value = (await bg<{ subjects: string[] }>({ cmd: 'meta.get' })).subjects;
  } catch { /* use defaults */ }
  const cfg = preset.value?.config ?? null;
  if (cfg) {
    await lookupTask(cfg);
  } else {
    state.value = { view: 'adapt', draft: emptyConfig() };
  }
}

export async function lookupTask(cfg: AdapterConfig) {
  const info = readPaperInfo(cfg);
  if (info.examTitle && info.questionNo) {
    try {
      const r = await bg<{ task: TaskInfo | null }>({
        cmd: 'task.lookup',
        platformHost: location.host,
        exam: info.examTitle,
        q_index: info.questionNo,
      });
      if (r.task) {
        state.value = { view: 'ready', task: r.task };
        setNotice('info', '已载入这道题上次的评分设置，可直接开始；需要修改请点「题目设置」');
        return;
      }
    } catch { /* fall through to task form */ }
  }
  const info2 = readPaperInfo(cfg);
  state.value = { view: 'task', form: new TaskForm(null, { examTitle: info2.examTitle, questionNo: info2.questionNo, maxScore: info2.maxScore }), existingTask: null };
}

// ---------- 适配向导 ----------

export function startAdapt() {
  const existing = preset.value?.config ?? null;
  clearNotice();
  state.value = { view: 'adapt', draft: existing ? structuredClone(existing) : emptyConfig() };
}

export async function saveDraft(draft: AdapterConfig) {
  try {
    const p = await bg<import('../../shared/protocol').Preset>({
      cmd: 'adapter.save',
      name: `${document.title.slice(0, 40) || location.host}`,
      hostPattern: location.hostname,
      pathPattern: '',
      config: draft,
    });
    preset.value = p;
    setNotice('ok', '适配已保存，下次打开这个平台会自动使用');
    await lookupTask(p.config);
  } catch (e) { setNotice('error', errText(e)); }
}

// ---------- 题目设置 ----------

export function openTaskForm(existingTask: TaskInfo | null) {
  const cfg = preset.value?.config;
  const info = cfg ? readPaperInfo(cfg) : { examTitle: '', questionNo: '', maxScore: null };
  state.value = { view: 'task', form: new TaskForm(existingTask, info), existingTask };
  clearNotice();
}

export async function saveTask(form: TaskForm) {
  if (!form.validate()) return; // errors written into form
  form.submitError = null;
  try {
    const task = await bg<TaskInfo>({ cmd: 'task.upsert', task: form.toTaskInput(location.host) });
    form.commit(task);
    lastFingerprint.value = '';
    autoAttempted.value = '';
    setNotice('ok', '题目设置已保存');
    state.value = { view: 'ready', task };
  } catch (e) {
    form.submitError = errText(e);
  }
}

// ---------- 评分 ----------

let abortController: AbortController | null = null;
/** Monotonic counter to distinguish concurrent judgeOnce() calls. */
let judgeGeneration = 0;

export async function judgeOnce(force = false, preCaptured?: string): Promise<GradingInfo | null> {
  const cur = state.value;
  const task = 'task' in cur ? (cur as { task: TaskInfo }).task : null;
  if (!task) return null;
  const cfg = preset.value?.config;
  if (!cfg) return null;

  clearNotice();
  state.value = { view: 'judging', task, auto: false };
  const gen = ++judgeGeneration;

  try {
    const info = readPaperInfo(cfg);
    if (info.questionNo && info.questionNo !== task.exam.q_index && !cfg.questionNo.fixed) {
      throw new AdapterError(`页面题号变成了「${info.questionNo}」，与当前任务「${task.exam.q_index}」不一致，请到「题目设置」确认`);
    }
    const image = preCaptured ?? (await captureAnswer(cfg.pics));
    if (gen !== judgeGeneration) return null; // superseded by a newer request
    lastImage.value = image;
    lastFingerprint.value = fingerprint(cfg);
    const r = await bg<GradingInfo>({ cmd: 'judge.run', taskId: task.taskId, image, force });
    if (gen !== judgeGeneration) return null; // superseded while awaiting
    if (state.value.view !== 'judging') return null;
    if (user.value) user.value = { ...user.value, credits: r.balance };
    state.value = { view: 'result', task, result: r };
    return r;
  } catch (e) {
    if (gen !== judgeGeneration) return null; // superseded
    setNotice('error', errText(e));
    state.value = { view: 'ready', task };
    return null;
  }
}

export async function commitScore(score: number, andNext: boolean, autoSubmitted: boolean): Promise<boolean> {
  const cur = state.value;
  if (cur.view !== 'result') return false;
  const { task, result: r } = cur;
  const cfg = preset.value?.config;
  if (!cfg) return false;

  try {
    if (isTransientFingerprint(lastFingerprint.value)) {
      console.warn('[EasyGrader] 答卷指纹处于过渡状态，跳过写分前校验', lastFingerprint.value);
    } else {
      const now = await confirmUnchanged(cfg, lastFingerprint.value);
      if (now !== null) {
        let image: string;
        try { image = await captureAnswer(cfg.pics); } catch {
          throw new AdapterError('页面上的答卷已经变了，本次评分作废，请重新获取建议分');
        }
        if (image === lastImage.value) {
          console.warn('[EasyGrader] 指纹变化但图片一致，按原评分写入', { expected: lastFingerprint.value, now });
        } else {
          console.warn('[EasyGrader] 答卷已变化，自动重新评分', { expected: lastFingerprint.value, now });
          const again = await judgeOnce(false, image);
          if (again) setNotice('warn', '页面上的答卷已变化，已自动重新评分，请核对分数后再写入');
          return false;
        }
      }
    }
    setScore(cfg, score, r.maxScore);
    await new Promise<void>((res) => setTimeout(res, 120));
    if (!verifyScore(cfg, score)) throw new AdapterError('分数写入后读回不一致，平台可能拒绝了输入，请手动给分');

    // confirm: await and surface recoverable failure (platform score already written)
    try {
      await bg({ cmd: 'record.confirm', gradingId: r.gradingId, modifiedScore: score, isAuto: autoSubmitted });
    } catch (e) {
      console.warn('[EasyGrader] record.confirm failed:', e);
      if (!autoSubmitted) {
        setNotice('warn', `分数已写入平台，但服务端记录确认失败：${errText(e)}。评分历史可能不一致，请联系管理员。`);
        state.value = { view: 'ready', task };
        return false;
      }
      // Auto mode: log and continue
      setNotice('warn', `上一份的服务端记录确认失败：${errText(e)}`);
    }

    if (!andNext) {
      setNotice('ok', `已写入 ${fmt(score)} 分，请在平台上检查后手动提交`);
      state.value = { view: 'ready', task };
      return true;
    }
    state.value = { view: 'waiting', task, auto: false };
    const before = fingerprintParts(cfg);
    const rejectBefore = rejectText();
    await submit(cfg);
    const rejected = await waitRejectChange(rejectBefore);
    if (rejected) {
      console.warn(`[EasyGrader] 平台拒绝提交：${rejected}，改用键盘输入重写`);
      setNotice('warn', `平台提示「${rejected}」，正在重写分数…`);
      await typeScore(cfg, score);
      await new Promise<void>((res) => setTimeout(res, 150));
      if (!verifyScore(cfg, score)) throw new AdapterError('分数写入后读回不一致，平台可能拒绝了输入，请手动给分');
      await submit(cfg);
    }
    sessionCount.value += 1;
    const changed = await waitForNext(cfg, before, abortController?.signal);
    if (!changed) {
      stopAuto();
      const stillRejected = rejectText();
      if (stillRejected) {
        setNotice('error', `平台提示「${stillRejected}」，这次没有写入成功，请手动给分后继续`);
        state.value = { view: 'result', task, result: r };
        return false;
      }
      setNotice('warn', '提交后答卷没有变化：可能已全部阅完，或平台需要人工操作。');
      state.value = { view: 'ready', task };
      return false;
    }
    setNotice('ok', `已提交 ${fmt(score)} 分，已切换到下一份`);
    state.value = { view: 'ready', task };
    return true;
  } catch (e) {
    stopAuto();
    setNotice('error', errText(e));
    state.value = { view: 'result', task, result: r };
    return false;
  }
}

// ---------- 自动连续阅卷 ----------

export const isAuto = signal(false);

export function stopAuto(msg?: string) {
  const was = isAuto.value;
  isAuto.value = false;
  abortController?.abort();
  abortController = null;
  // In manual/semi-auto mode, also transition out of judging/waiting
  const cur = state.value;
  const task = 'task' in cur ? (cur as { task: TaskInfo }).task : null;
  if (task && (cur.view === 'judging' || cur.view === 'waiting' || (msg && was))) {
    if (msg) setNotice('info', msg);
    state.value = { view: 'ready', task };
  }
}

/** 本页面已经确认过一次全自动风险提示，之后再开启不再询问 */
let autoConfirmed = false;

/**
 * 切换阅卷模式。任何视图都能调用：
 *   - 离开全自动会停止循环
 *   - 进入全自动第一次需要在面板里确认，确认后才真正切换
 */
export function setMode(next: Mode) {
  autoConfirmPending.value = false;
  if (next === mode.value) return;
  if (next !== 'auto') {
    const wasAuto = mode.value === 'auto';
    autoPaused.value = false;
    mode.value = next;
    if (wasAuto) stopAuto(isAuto.value ? '已停止自动阅卷' : undefined);
    judgeCandidate.value = null;
    autoAttempted.value = '';
    if (next === 'semi') setNotice('info', '已切到半自动：换到新答卷会自动获取建议分，不会写入或提交');
    else if (!wasAuto) setNotice('info', '已切到手动');
    return;
  }
  if (!autoConfirmed) { autoConfirmPending.value = true; return; }
  startAuto();
}

/** 面板内确认开启全自动 */
export function confirmAuto() {
  autoConfirmed = true;
  autoConfirmPending.value = false;
  startAuto();
}

export function cancelAutoConfirm() {
  autoConfirmPending.value = false;
}

/** 进入全自动：在就绪页直接开始循环；在结果页先让老师处理这一份 */
function startAuto() {
  mode.value = 'auto';
  const view = state.value.view;
  if (view !== 'ready') {
    // 评分中/结果页/等待换卷：先把这一份处理完，再由老师点继续
    autoPaused.value = true;
    setNotice('info', '已切到全自动：处理完这一份后点「确认并继续自动」或「继续自动阅卷」');
    return;
  }
  autoPaused.value = false;
  void runAuto();
}

/** 低置信度暂停后：老师确认这一份的分数，提交后继续循环 */
export async function confirmAndContinue(score: number) {
  const ok = await commitScore(score, true, false);
  if (!ok || mode.value !== 'auto') return;
  autoPaused.value = false;
  void runAuto();
}

/** 全自动已暂停/中断时，从就绪页继续 */
export function resumeAuto() {
  if (mode.value !== 'auto' || isAuto.value) return;
  autoPaused.value = false;
  void runAuto();
}

export async function runAuto() {
  if (isAuto.value) return; // 已经有一个循环在跑，不再启动第二个
  const s = settings.value;
  if (!s) return;
  const cur = state.value;
  if (cur.view !== 'ready') return;
  isAuto.value = true;
  const ctrl = new AbortController();
  abortController = ctrl;
  const signal = ctrl.signal;
  while (isAuto.value && !signal.aborted) {
    const started = Date.now();
    const r = await judgeOnce();
    if (!r || !isAuto.value || signal.aborted) break;
    if (r.confidence < s.autoMinConfidence) {
      isAuto.value = false;
      autoPaused.value = true;
      setNotice('warn', `置信度 ${Math.round(r.confidence * 100)}% 较低，已暂停。核对分数后点「确认并继续自动」，或切回手动`);
      break;
    }
    const ok = await commitScore(r.score, true, true);
    if (!ok || !isAuto.value || signal.aborted) break;
    const wait = s.autoIntervalMs - (Date.now() - started);
    if (wait > 0) await new Promise<void>((res) => setTimeout(res, wait));
  }
  // 只有当前这个循环还是"在跑的那个"时才收尾，避免停止后又开的新循环被误关
  if (abortController === ctrl || abortController === null) {
    isAuto.value = false;
    if (abortController === ctrl) abortController = null;
    // 出错、额度不足、阅完等原因中断：回到手动；低置信度暂停则保持全自动等老师确认
    if (mode.value === 'auto' && !autoPaused.value) mode.value = 'manual';
  }
}

/** 轮询检测新答卷（每秒调一次） */
export function maybeAutoJudge() {
  if (mode.value !== 'semi') return;
  const cur = state.value;
  if (cur.view !== 'ready' || isAuto.value) return;
  const cfg = preset.value?.config;
  if (!cfg) return;
  let fp: string;
  try { fp = fingerprint(cfg); } catch { return; }
  if (isTransientFingerprint(fp) || fp === lastFingerprint.value || fp === autoAttempted.value) {
    judgeCandidate.value = null;
    return;
  }
  const now = Date.now();
  if (!judgeCandidate.value || fp !== judgeCandidate.value.fp) {
    judgeCandidate.value = { fp, at: now };
    return;
  }
  if (now - judgeCandidate.value.at < 700) return;
  judgeCandidate.value = null;
  autoAttempted.value = fp;
  void judgeOnce();
}

const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
