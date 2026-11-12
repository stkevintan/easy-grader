/** 评分进行中/等待换卷视图 */
import { h } from 'preact';
import { isAuto, setMode, stopAuto } from '../controller';
import type { TaskInfo } from '../../../shared/protocol';

interface JudgingProps { task: TaskInfo; }
interface WaitingProps { task: TaskInfo; auto: boolean; }

export function JudgingView({ task: _ }: JudgingProps) {
  return (
    <div>
      <div class="msg info">正在读取答卷并请求评分…</div>
      <div class="foot">
        {isAuto.value ? (
          <button class="btn danger grow" onClick={() => setMode('manual')}>停止自动阅卷</button>
        ) : (
          // 请求已经发出，丢弃结果并不能撤回扣费，按钮和说明都直说
          <button class="btn grow" onClick={() => stopAuto('已丢弃这次结果（本次评分仍会扣次数）')}>不看这次结果</button>
        )}
      </div>
      {isAuto.value && <p class="muted">停止后，这一份的评分请求仍会完成并扣次数。</p>}
      {!isAuto.value && <p class="muted">评分请求已发出，不看结果也会扣次数。</p>}
    </div>
  );
}

export function WaitingView({ task: _ }: WaitingProps) {
  return (
    <div>
      <div class="msg info">已提交，等待平台切换到下一份答卷…</div>
      <div class="foot">
        {isAuto.value ? (
          <button class="btn danger grow" onClick={() => setMode('manual')}>停止自动阅卷</button>
        ) : (
          <button class="btn grow" onClick={() => stopAuto('已停止等待换卷')}>不再等待</button>
        )}
      </div>
    </div>
  );
}
