/** 评分结果视图 */
import { h } from 'preact';
import { useSignal } from '@preact/signals';
import type { GradingInfo, TaskInfo } from '../../../shared/protocol';
import { commitScore, judgeOnce, stopAuto, isAuto } from '../controller';
import { notice, state } from '../store';

const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);

interface Props {
  task: TaskInfo;
  result: GradingInfo;
}

export function ResultView({ task, result: r }: Props) {
  const score = useSignal(String(r.score));
  const confClass = r.confidence >= 0.8 ? 'high' : r.confidence >= 0.6 ? 'mid' : 'low';

  const commit = async (andNext: boolean) => {
    const v = Number(score.value);
    if (!Number.isFinite(v) || v < 0 || v > r.maxScore) {
      notice.value = { kind: 'error', text: `分数需在 0-${fmt(r.maxScore)} 之间` };
      return;
    }
    await commitScore(v, andNext, false);
  };

  return (
    <div>
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
        <details>
          <summary>识别出的答卷文字</summary>
          <pre class="ocr">{r.ocr}</pre>
        </details>
      )}
      <div class="foot">
        <button class="btn primary grow" onClick={() => commit(true)}>写入并提交</button>
        <button class="btn" onClick={() => commit(false)}>只写入</button>
        <button class="btn" onClick={() => void judgeOnce(true)}>重评</button>
        <button class="btn" onClick={() => {
          notice.value = null;
          state.value = { view: 'ready', task };
        }}>放弃</button>
      </div>
    </div>
  );
}
