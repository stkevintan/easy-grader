/**
 * PanelApp: Preact 根组件，挂载在 Shadow DOM 内的 #panel-app 元素上。
 * Shadow DOM shell（拖动、最小化、关闭按钮）仍由 ui.ts 管理，不动。
 */
import { h, Fragment } from 'preact';
import { useSignal, useSignalEffect } from '@preact/signals';
import { state, notice, user } from './store';
import type { PanelState } from './store';
import { LoginView } from './views/LoginView';
import { AdaptView } from './views/AdaptView';
import { TaskFormView } from './views/TaskFormView';
import { ReadyView } from './views/ReadyView';
import { ResultView } from './views/ResultView';
import { JudgingView, WaitingView } from './views/InProgressViews';
import { ModeBar } from './views/ModeBar';

export function PanelApp() {
  // Subscribe to signals so Preact re-renders on any change
  const s = state.value;
  const n = notice.value;
  const u = user.value;

  const renderView = (s: PanelState) => {
    switch (s.view) {
      case 'login':   return <LoginView />;
      case 'adapt':   return <AdaptView draft={s.draft} />;
      case 'task':    return <TaskFormView form={s.form} existingTask={s.existingTask} />;
      case 'ready':   return <ReadyView task={s.task} />;
      case 'judging': return <JudgingView task={s.task} />;
      case 'result':  return <ResultView task={s.task} result={s.result} />;
      case 'waiting': return <WaitingView task={s.task} auto={s.auto} />;
    }
  };

  return (
    <>
      {n && <div class={`msg ${n.kind}`} role={n.kind === 'error' ? 'alert' : 'status'}>{n.text}</div>}
      {(s.view === 'ready' || s.view === 'judging' || s.view === 'result' || s.view === 'waiting') && <ModeBar />}
      {renderView(s)}
    </>
  );
}
