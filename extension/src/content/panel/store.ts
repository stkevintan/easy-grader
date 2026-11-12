/**
 * Panel store: 判别联合状态机 + 共享信号
 *
 * 所有面板状态都在这一个文件里；异步回调可以在返回前检查 state.value.view，
 * 判断"用户是否已经切走了"，从而避免旧请求污染新状态。
 */
import { signal, computed } from '@preact/signals';
import type { AdapterConfig } from '../../shared/adapter-config';
import type { ClientFlags, GradingInfo, PublicUser, Settings, TaskInfo } from '../../shared/protocol';
import { SAFE_FLAGS, compareVersions } from '../../shared/protocol';
import { TaskForm } from './forms/task-form';

// ---------- 状态机类型 ----------

export type PanelState =
  | { view: 'login' }
  | { view: 'adapt'; draft: AdapterConfig }
  | { view: 'task'; form: TaskForm; existingTask: TaskInfo | null }
  | { view: 'ready'; task: TaskInfo }
  | { view: 'judging'; task: TaskInfo; auto: boolean }
  | { view: 'result'; task: TaskInfo; result: GradingInfo }
  | { view: 'waiting'; task: TaskInfo; auto: boolean };

// ---------- 信号 ----------

export const state   = signal<PanelState>({ view: 'login' });
export const user    = signal<PublicUser | null>(null);
export const notice  = signal<{ kind: 'info' | 'ok' | 'warn' | 'error'; text: string } | null>(null);
export const settings = signal<Settings | null>(null);
export const subjects = signal<string[]>(['语文', '数学', '英语', '历史', '地理', '道德与法治', '政治', '物理', '化学', '生物', '其他']);
/** 服务端功能开关；拉到之前按保守取值（全自动不可用） */
export const flags   = signal<ClientFlags>(SAFE_FLAGS);
export const extVersion = signal('');

/** 全自动实际使用的置信度下限：老师设置和服务端下限取更严的那个 */
export const effectiveMinConfidence = computed(() =>
  Math.max(settings.value?.autoMinConfidence ?? 0, flags.value.auto_min_confidence));
/** 扩展版本低于服务端要求的最低版本 */
export const outdated = computed(() => {
  const min = flags.value.min_extension_version;
  return !!min && !!extVersion.value && compareVersions(extVersion.value, min) < 0;
});
export const preset  = signal<import('../../shared/protocol').Preset | null>(null);

/**
 * 阅卷模式，只在本次打开面板期间有效（关闭面板回到手动）：
 *   manual 手动：点「获取建议分」才评分
 *   semi   半自动：换到新答卷自动出建议分，不写入不提交
 *   auto   全自动：自动写分并提交（循环是否在跑看 controller.isAuto）
 */
export type Mode = 'manual' | 'semi' | 'auto';
export const mode = signal<Mode>('manual');
/** 全自动因置信度低暂停在结果页，等老师确认这一份 */
export const autoPaused = signal(false);
/** 正在面板内确认是否开启全自动 */
export const autoConfirmPending = signal(false);
/** 有一次写分/提交正在进行（手动或全自动），期间结果页的按钮和快捷键都不可用 */
export const committing = signal(false);

// 半自动阅卷：监听器相关
export const judgeCandidate = signal<{ fp: string; at: number } | null>(null);
export const autoAttempted  = signal('');   // 已经自动触发过的指纹
export const lastFingerprint = signal('');  // 最后评分时的答卷指纹
export const lastImage       = signal('');  // 最后评分时的答卷图片 data URL
export const sessionCount    = signal(0);
/** 适配向导点选中：面板收成一条，让出页面操控权 */
export const isPicking        = signal(false);

// ---------- 便利写入 ----------

export const setNotice = (kind: 'info'|'ok'|'warn'|'error', text: string) => { notice.value = { kind, text }; };
export const clearNotice = () => { notice.value = null; };

/** 只有当前 view 是 task 时才有 form */
export const taskForm = computed<TaskForm | null>(() =>
  state.value.view === 'task' ? state.value.form : null,
);
