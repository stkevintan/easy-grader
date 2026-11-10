import type { PublicUser, Settings } from './shared/protocol';
import { bg } from './shared/protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, on: boolean) => ($(id).hidden = !on);
const say = (id: string, kind: 'ok' | 'error', text: string) => {
  const el = $(id);
  el.className = `msg ${kind}`;
  el.textContent = text;
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let user: PublicUser | null = null;
let tab: chrome.tabs.Tab | undefined;

/** 当前标签页能否注入：只处理 http(s) 页面 */
const tabOrigin = () => {
  try {
    const u = new URL(tab?.url ?? '');
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
};

async function renderAccount() {
  const r = await bg<{ user: PublicUser | null; offline?: boolean }>({ cmd: 'auth.status' }).catch((e) => {
    say('login-msg', 'error', errText(e));
    return { user: null, offline: true };
  });
  user = r.user;
  show('login', !user);
  show('account', !!user);
  if (user) {
    $('who').textContent = `${user.username}${user.role === 'admin' ? '（管理员）' : ''}${r.offline ? ' · 服务端离线' : ''}`;
    $('credits').textContent = String(user.credits);
  }
  await renderPage();
}

async function renderPage() {
  const origin = tabOrigin();
  show('page', !!user && !!origin);
  if (!user || !origin || !tab?.id) return;
  $('page-origin').textContent = origin;
  const sites = await bg<string[]>({ cmd: 'site.list' });
  // 开发版的 manifest 自带本机演示页的内容脚本，无需单独启用
  const builtIn = __DEV__ && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  const enabled = builtIn || sites.includes(origin);
  show('site-row', !enabled);
  $<HTMLButtonElement>('open-panel').textContent = enabled ? '打开 / 关闭阅卷面板' : '在本页临时打开面板';

  show('sites-section', sites.length > 0);
  $('sites').replaceChildren(
    ...sites.map((s) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = s;
      span.title = s;
      const btn = document.createElement('button');
      btn.className = 'link';
      btn.type = 'button';
      btn.textContent = '停用';
      btn.addEventListener('click', async () => {
        await bg({ cmd: 'site.disable', origin: s });
        await renderPage();
      });
      li.append(span, btn);
      return li;
    }),
  );
}

/** 先试着给已注入的内容脚本发消息；没有就临时注入（activeTab 授权，仅本次有效） */
async function togglePanel() {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { cmd: 'panel.toggle' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['insert.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { cmd: 'panel.toggle' });
    } catch (e) {
      say('page-msg', 'error', `无法在此页面打开：${errText(e)}`);
      return;
    }
  }
  window.close();
}

/** 申请站点权限必须在用户点击的同步调用栈里发起 */
function enableSite() {
  const origin = tabOrigin();
  if (!origin) return;
  chrome.permissions.request({ origins: [`${origin}/*`] }, async (granted) => {
    if (!granted) return say('page-msg', 'error', '未授权，无法在此站点启用');
    try {
      await bg({ cmd: 'site.enable', origin });
      say('page-msg', 'ok', '已启用。刷新页面后，点「打开阅卷面板」即可使用。');
      await renderPage();
    } catch (e) {
      say('page-msg', 'error', errText(e));
    }
  });
}

async function auth(cmd: 'auth.login' | 'auth.register') {
  const username = $<HTMLInputElement>('username').value.trim();
  const password = $<HTMLInputElement>('password').value;
  if (!username || password.length < 8) return say('login-msg', 'error', '请输入用户名和至少 8 位密码');
  try {
    await bg({ cmd, username, password });
    $<HTMLInputElement>('password').value = '';
    say('login-msg', 'ok', '');
    await renderAccount();
  } catch (e) {
    say('login-msg', 'error', errText(e));
  }
}

/** 开发版才有：在设置里插入服务端地址输入框。发布版构建时这段会被整个删掉 */
function mountServerField() {
  if (!__DEV__) return;
  const label = document.createElement('label');
  label.htmlFor = 'server-url';
  label.textContent = '服务端地址（仅开发版）';
  const input = document.createElement('input');
  input.id = 'server-url';
  input.type = 'url';
  input.placeholder = 'http://127.0.0.1:3000';
  $('server-slot').append(label, input);
}

async function loadSettings() {
  const s = await bg<Settings>({ cmd: 'settings.get' });
  if (__DEV__) $<HTMLInputElement>('server-url').value = s.serverUrl;
  $<HTMLInputElement>('min-conf').value = String(Math.round(s.autoMinConfidence * 100));
  $<HTMLInputElement>('interval').value = String(s.autoIntervalMs / 1000);
}

async function saveSettings() {
  const conf = Number($<HTMLInputElement>('min-conf').value);
  const interval = Number($<HTMLInputElement>('interval').value);
  if (!(conf >= 0 && conf <= 100)) return say('settings-msg', 'error', '置信度需在 0-100 之间');
  if (!(interval >= 1 && interval <= 60)) return say('settings-msg', 'error', '间隔需在 1-60 秒之间');
  const next: Partial<Settings> = { autoMinConfidence: conf / 100, autoIntervalMs: interval * 1000 };
  try {
    if (__DEV__) {
      const origin = new URL($<HTMLInputElement>('server-url').value.trim()).origin;
      // 非本机服务端需要额外的主机权限
      if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
        if (!granted) return say('settings-msg', 'error', '未授权访问该服务端地址');
      }
      next.serverUrl = origin;
    }
    await bg({ cmd: 'settings.set', settings: next });
    say('settings-msg', 'ok', '已保存');
    await renderAccount();
  } catch (e) {
    say('settings-msg', 'error', errText(e));
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  mountServerField();

  $('toggle-settings').addEventListener('click', () => {
    const open = $('settings').hidden;
    show('settings', open);
    $('toggle-settings').setAttribute('aria-expanded', String(open));
  });
  $('save-settings').addEventListener('click', saveSettings);
  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void auth('auth.login');
  });
  $('register-btn').addEventListener('click', () => auth('auth.register'));
  $('logout').addEventListener('click', async () => {
    await bg({ cmd: 'auth.logout' });
    await renderAccount();
  });
  $('redeem-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $<HTMLInputElement>('code').value.trim();
    try {
      const r = await bg<{ credits: number; balance: number }>({ cmd: 'billing.redeem', code });
      $<HTMLInputElement>('code').value = '';
      say('redeem-msg', 'ok', `兑换成功，增加 ${r.credits} 次`);
      $('credits').textContent = String(r.balance);
    } catch (err) {
      say('redeem-msg', 'error', errText(err));
    }
  });
  $('open-panel').addEventListener('click', togglePanel);
  $('enable-site').addEventListener('click', enableSite);

  await loadSettings();
  await renderAccount();
});
