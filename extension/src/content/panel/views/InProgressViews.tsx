/** 评分进行中/等待换卷视图 */
import { h } from 'preact';
import { stopAuto, isAuto } from '../controller';
import { state } from '../store';
import type { TaskInfo } from '../../../shared/protocol';

interface JudgingProps { task: TaskInfo; }
interface WaitingProps { task: TaskInfo; auto: boolean; }

export function JudgingView({ task: _ }: JudgingProps) {
  return (
    <div>
      <div class="msg info">正在读取答卷并请求评分…</div>
      <div class="foot">
        <button class="btn grow" onClick={() => stopAuto('已停止')}>
          {isAuto.value ? '停止自动阅卷' : '取消'}
        </button>
      </div>
    </div>
  );
}

export function WaitingView({ task: _ }: WaitingProps) {
  return (
    <div>
      <div class="msg info">已提交，等待平台切换到下一份答卷…</div>
      <div class="foot">
        <button class="btn grow" onClick={() => stopAuto('已停止')}>
          {isAuto.value ? '停止自动阅卷' : '取消'}
        </button>
      </div>
    </div>
  );
}
