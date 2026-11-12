/** 评分结果视图 */
import { h } from 'preact';
import { useSignal } from '@preact/signals';
import type { GradingInfo, TaskInfo } from '../../../shared/protocol';
import { commitScore, confirmAndContinue, judgeOnce } from '../controller';
import { autoPaused, committing, mode, notice, state } from '../store';

const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);

interface Props {
  task: TaskInfo;
  result: GradingInfo;
}

export function ResultView({ task, result: r }: Props) {
  const score = useSignal(String(r.score));
  const localBusy = useSignal(false);
  // 全自动循环自己发起的提交也算忙：按钮和 Enter 都不能再提交一次
  const busy = { get value() { return localBusy.value || committing.value; } };
  const confClass = r.confidence >= 0.8 ? 'high' : r.confidence >= 0.6 ? 'mid' : 'low';
  // 全自动因置信度低等原因暂停在这一份：主按钮换成「确认并继续自动」
  const paused = mode.value === 'auto' && autoPaused.value;
  // 识别文字默认显示，过长时只露前几行，可展开
  const ocrOpen = useSignal(false);
  const ocrLong = !!r.ocr && (r.ocr.length > 120 || r.ocr.split('\n').length > 4);

  const parsed = (): number | null => {
    const v = Number(score.value);
    if (score.value.trim() === '' || !Number.isFinite(v) || v < 0 || v > r.maxScore) {
      notice.value = { kind: 'error', text: `分数需在 0-${fmt(r.maxScore)} 之间` };
      return null;
    }
    return v;
  };

  const run = async (fn: (v: number) => Promise<unknown>) => {
    if (busy.value) return;
    const v = parsed();
    if (v === null) return;
    localBusy.value = true;
    try { await fn(v); } finally { localBusy.value = false; }
  };

  const primary = () => run((v) => paused ? confirmAndContinue(v) : commitScore(v, true, false));
  const discard = () => {
    notice.value = null;
    state.value = { view: 'ready', task };
  };

  return (
    <div
      onKeyDown={(e) => {
        // Esc 放弃；在分数框里按 Enter 等同主按钮（按钮自己的 Enter 仍是点它本身）
        // 提交进行中忽略 Esc：否则看起来放弃了，实际分数仍可能被写入提交
        if (e.key === 'Escape') { e.preventDefault(); if (!busy.value) discard(); return; }
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          void primary();
        }
      }}
    >
      <div class="score">
        <input
          type="number" min={0} max={r.maxScore} step={task.scoreStep}
          value={score.value}
          aria-label="最终分数"
          onInput={(e) => { score.value = (e.target as HTMLInputElement).value; }}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autofocus
        />
        <span class="max">/ {fmt(r.maxScore)}</span>
        <span class={`conf ${confClass}`} title="模型对本次评分的把握程度">
          置信度 {Math.round(r.confidence * 100)}%
        </span>
      </div>
      {r.model === 'mock' && <div class="msg warn">服务端未配置模型，当前是 mock 分数，请勿用于真实阅卷</div>}
      {r.samples && r.samples.length > 1 && (
        <p class="muted">多次评分：{r.samples.join(' / ')}{r.scoreSpread ? '（不一致，请重点核对）' : ''}</p>
      )}
      {r.cached && <p class="muted">这份答卷之前评过，直接使用上次结果（未扣次数）</p>}
      {r.reasons.length > 0 ? (
        <ul class="reasons">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
      ) : r.reason ? (
        <p>{r.reason}</p>
      ) : null}
      {r.comment && <p>{r.comment}</p>}
      {r.ocr && (
        <div class="ocr-box">
          <div class="ocr-head">
            <span>识别出的答卷文字</span>
            {ocrLong && (
              <button type="button" class="link" onClick={() => { ocrOpen.value = !ocrOpen.value; }}>
                {ocrOpen.value ? '收起' : '展开全文'}
              </button>
            )}
          </div>
          <pre class={`ocr${ocrLong && !ocrOpen.value ? ' clamp' : ''}`}>{r.ocr}</pre>
        </div>
      )}
      <div class="foot">
        <button class="btn primary grow" disabled={busy.value} onClick={() => void primary()}>
          {paused ? '确认并继续自动' : '写入并提交'}
        </button>
        <button class="btn" disabled={busy.value} onClick={() => void run((v) => commitScore(v, false, false))}>只写入</button>
        <button class="btn" disabled={busy.value} onClick={() => void judgeOnce(true)}>重评</button>
        <button class="btn" disabled={busy.value} onClick={discard}>放弃</button>
      </div>
      <p class="muted keys">Enter {paused ? '确认并继续' : '写入并提交'} · Esc 放弃</p>
    </div>
  );
}
