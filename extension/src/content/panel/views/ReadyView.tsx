/** 就绪视图：已有任务，等待老师点"获取建议分" */
import { h } from 'preact';
import type { TaskInfo } from '../../../shared/protocol';
import { isAuto, judgeOnce, openTaskForm, runAuto, stopAuto, toggleAutoJudge } from '../controller';
import { settings, sessionCount } from '../store';

const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);

interface Props {
  task: TaskInfo;
}

export function ReadyView({ task }: Props) {
  const autoJudge = settings.value?.autoJudge ?? false;
  return (
    <div>
      <dl class="kv">
        <dt>考试</dt><dd title={task.exam.exam}>{task.exam.exam}</dd>
        <dt>题号</dt><dd>{task.exam.q_index}（{task.exam.subject}，满分 {fmt(Number(task.question.content.score ?? 0))}）</dd>
        <dt>本次</dt><dd>已阅 {sessionCount.value} 份</dd>
      </dl>
      <p class="muted">
        {autoJudge
          ? '半自动判题已开启：换到新答卷会自动获取建议分，不会写入或提交。'
          : '「获取建议分」只会给出分数和理由，确认后才写入平台并提交。'}
      </p>
      <div class="foot stack">
        <button class="btn primary grow" onClick={() => void judgeOnce()}>获取建议分</button>
        <button class="btn" onClick={() => {
          const s = settings.value;
          if (!s) return;
          const ok = window.confirm(
            [
              '开启自动连续阅卷后，扩展会自动：读取答卷 → AI 评分 → 写入分数 → 提交 → 下一份。',
              '',
              `· 置信度低于 ${Math.round(s.autoMinConfidence * 100)}% 时会暂停，等你确认`,
              `· 每份之间至少间隔 ${s.autoIntervalMs / 1000} 秒`,
              '· 写分校验失败、换卷超时、额度不足都会自动停止',
              '',
              '请确认：你有权在该平台使用自动化工具，并会对最终分数负责。',
              '确定开启吗？',
            ].join('\n'),
          );
          if (ok) void runAuto({ autoMinConfidence: s.autoMinConfidence, autoIntervalMs: s.autoIntervalMs });
        }}>自动连续阅卷</button>
        <button class="btn" onClick={() => void toggleAutoJudge()}>
          {autoJudge ? '半自动：开' : '半自动判题'}
        </button>
        <button class="btn" onClick={() => openTaskForm(task)}>题目设置</button>
      </div>
    </div>
  );
}
