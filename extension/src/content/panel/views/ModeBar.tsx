/**
 * 阅卷模式切换条：手动 / 半自动 / 全自动。
 * 在就绪、评分中、结果、等待换卷几个视图顶部常驻，任何时候都能看到当前模式并切换或停止。
 */
import { h } from 'preact';
import { cancelAutoConfirm, confirmAuto, isAuto, setMode } from '../controller';
import { autoConfirmPending, effectiveMinConfidence, flags, mode, settings } from '../store';
import type { Mode } from '../store';

const LABELS: { mode: Mode; label: string }[] = [
  { mode: 'manual', label: '手动' },
  { mode: 'semi', label: '半自动' },
  { mode: 'auto', label: '全自动' },
];

function describe(m: Mode, running: boolean): string {
  if (m === 'semi') return '半自动：换到新答卷自动出建议分，写入和提交仍由你确认';
  if (m === 'auto') return running ? '全自动阅卷中：自动写分并提交下一份' : '全自动已暂停：处理完这一份后继续';
  return '手动：点「获取建议分」才评分，确认后才写入';
}

export function ModeBar() {
  const m = mode.value;
  const running = isAuto.value;
  const s = settings.value;
  // 管理员关掉全自动时按钮置灰；正在全自动时仍可点别的模式退出
  const autoOff = !flags.value.auto_mode;
  return (
    <div class="mode">
      <div class="seg" role="group" aria-label="阅卷模式">
        {LABELS.map((x) => (
          <button
            key={x.mode}
            class={`seg-btn${m === x.mode ? ' on' : ''}${x.mode === 'auto' ? ' risky' : ''}`}
            aria-pressed={m === x.mode}
            disabled={x.mode === 'auto' && autoOff && m !== 'auto'}
            title={x.mode === 'auto' && autoOff ? '全自动阅卷已被管理员暂停' : undefined}
            onClick={() => setMode(x.mode)}
          >{x.label}</button>
        ))}
      </div>
      <p class={`mode-desc ${m}`}>{describe(m, running)}</p>
      {autoConfirmPending.value && s && (
        <div class="msg warn confirm">
          <b>开启全自动阅卷？</b>
          {'\n'}扩展会自动：读取答卷 → AI 评分 → 写入分数 → 提交 → 下一份。
          {`\n· 置信度低于 ${Math.round(effectiveMinConfidence.value * 100)}% 时会暂停，等你确认`}
          {`\n· 每份之间至少间隔 ${s.autoIntervalMs / 1000} 秒`}
          {'\n· 写分校验失败、换卷超时、额度不足都会自动停止'}
          {'\n请确认你有权在该平台使用自动化工具，并对最终分数负责。本页面之后再开启不再询问。'}
          <div class="row confirm-actions">
            <button class="btn primary" onClick={() => confirmAuto()}>确认开启</button>
            <button class="btn" onClick={() => cancelAutoConfirm()}>先不开</button>
          </div>
        </div>
      )}
    </div>
  );
}
