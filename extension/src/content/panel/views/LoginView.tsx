/** 登录视图 */
import { h } from 'preact';
import { refreshUser } from '../controller';
import { notice, settings } from '../store';

export function LoginView() {
  const serverUrl = settings.value?.serverUrl ?? '';
  return (
    <div>
      <p class="muted">请先在浏览器工具栏点击 Easy Grader 图标登录，登录后回到这里点「刷新」。</p>
      {__DEV__ && <p class="muted">服务端（开发版）：{serverUrl}</p>}
      <div class="foot">
        <button class="btn primary grow" onClick={async () => {
          notice.value = null;
          await refreshUser();
        }}>刷新</button>
      </div>
    </div>
  );
}
