/** 就绪视图：已有任务，等待评分（或全自动两份之间的间隔） */
import { h } from 'preact';
import type { TaskInfo } from '../../../shared/protocol';
import { isAuto, judgeOnce, openTaskForm, resumeAuto, setMode } from '../controller';
import { committing, mode, sessionCount } from '../store';

const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);

interface Props {
  task: TaskInfo;
}

export function ReadyView({ task }: Props) {
  const running = isAuto.value;
  const m = mode.value;
  return (
    <div>
      <dl class="kv">
        <dt>考试</dt><dd title={task.exam.exam}>{task.exam.exam}</dd>
        <dt>题号</dt><dd>{task.exam.q_index}（{task.exam.subject}，满分 {fmt(Number(task.question.content.score ?? 0))}）</dd>
        <dt>本次</dt><dd>已阅 {sessionCount.value} 份</dd>
      </dl>
      {running ? (
        // 全自动两份之间的间隔：只给停止，不给会再开一个循环的按钮
        <>
          <p class="muted">全自动阅卷中，稍后自动评下一份…</p>
          <div class="foot">
            <button class="btn danger grow" onClick={() => setMode('manual')}>停止自动阅卷</button>
          </div>
        </>
      ) : (
        <div class="foot stack">
          {m === 'auto' ? (
            <button class="btn primary grow" disabled={committing.value} onClick={() => resumeAuto()}>继续自动阅卷</button>
          ) : (
            <button class="btn primary grow" onClick={() => void judgeOnce()}>获取建议分</button>
          )}
          <button class="btn" onClick={() => openTaskForm(task)}>题目设置</button>
        </div>
      )}
    </div>
  );
}
