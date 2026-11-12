/**
 * Service worker：
 * - 唯一能访问服务端的地方（token 只存在这里和 chrome.storage.local）
 * - 命令白名单路由，未知命令一律拒绝
 * - 代抓跨域答卷图片、可见区截图
 * - 管理用户启用的阅卷站点（动态注册内容脚本）
 */
import type { BgRequest, BgResponse, ClientFlags, FlagsResult, PublicUser, Settings } from './shared/protocol';
import { DEFAULT_SETTINGS, SAFE_FLAGS } from './shared/protocol';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface Store {
  token?: string;
  user?: PublicUser;
  settings?: Partial<Settings>;
  sites?: string[];
  /** 上次从服务端拉到的功能开关，拉取失败时沿用 */
  flags?: { value: ClientFlags; at: number; userId: number };
}

const store = {
  async get(): Promise<Store> {
    return (await chrome.storage.local.get(['token', 'user', 'settings', 'sites', 'flags'])) as Store;
  },
  set: (v: Partial<Store>) => chrome.storage.local.set(v),
  remove: (keys: (keyof Store)[]) => chrome.storage.local.remove(keys),
};

async function settings(): Promise<Settings> {
  const s = (await store.get()).settings ?? {};
  const merged = { ...DEFAULT_SETTINGS, ...s };
  // 发布版始终使用构建时写死的服务端，忽略存储里的值（例如从开发版升级上来残留的本机地址）
  if (!__DEV__) merged.serverUrl = __SERVER_URL__;
  return merged;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** asToken：用指定的 token 发请求（不传则读当前存储的）；401 时只有存储的仍是这个 token 才清掉登录态 */
async function api<T>(method: string, path: string, body?: unknown, timeoutMs = 15000, asToken?: string): Promise<T> {
  const { serverUrl } = await settings();
  const token = asToken ?? (await store.get()).token;
  let res: Response;
  try {
    res = await fetch(serverUrl.replace(/\/+$/, '') + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        // 服务端据此统计版本分布，并拒绝低于 min_extension_version 的扩展评分/提交
        'x-eg-version': EXT_VERSION,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    throw new ApiError(timeout ? '请求服务端超时' : `无法连接服务端 ${serverUrl}，请确认服务已启动`, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && (await store.get()).token === token) await store.remove(['token', 'user', 'flags']);
    const msg = Array.isArray(data?.message) ? data.message.join('；') : data?.message;
    throw new ApiError(msg || `服务端错误（HTTP ${res.status}）`, res.status);
  }
  return data as T;
}

const EXT_VERSION = chrome.runtime.getManifest().version;
/** 开关缓存时间：面板打开和全自动每份之前都会读，这期间不重复请求 */
const FLAGS_TTL_MS = 5 * 60 * 1000;

async function getFlags(refresh: boolean): Promise<FlagsResult> {
  const { flags: cached, user, token } = await store.get();
  if (!token) return { flags: SAFE_FLAGS, stale: true, version: EXT_VERSION };
  // 换了账号的缓存不能用：不同用户的开关可能不同
  const mine = cached && user && cached.userId === user.id ? cached : undefined;
  if (mine && !refresh && Date.now() - mine.at < FLAGS_TTL_MS) return { flags: mine.value, stale: false, version: EXT_VERSION };
  // 整个请求绑定在开始时的这次登录上：期间登出或换了账号，结果作废，不写缓存
  const sameSession = async () => (await store.get()).token === token;
  try {
    const r = await api<{ flags: Partial<ClientFlags> }>('GET', '/api/flags', undefined, 15000, token);
    if (!(await sameSession())) return { flags: SAFE_FLAGS, stale: true, version: EXT_VERSION };
    // 旧服务端没有某个字段时用保守值补齐
    const value: ClientFlags = { ...SAFE_FLAGS, ...r.flags };
    if (user) await store.set({ flags: { value, at: Date.now(), userId: user.id } });
    return { flags: value, stale: false, version: EXT_VERSION };
  } catch (e) {
    // 登录已失效（401）或会话已变：不能再用旧缓存，按保守取值
    if ((e instanceof ApiError && e.status === 401) || !(await sameSession())) {
      return { flags: SAFE_FLAGS, stale: true, version: EXT_VERSION };
    }
    return { flags: mine?.value ?? SAFE_FLAGS, stale: true, version: EXT_VERSION };
  }
}

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

/**
 * 代页面下载答卷图片。只在图片与页面同源时携带 cookie；
 * 跨域图片（如 OSS/CDN）不带凭据，避免页面借扩展身份访问任意站点。
 */
async function fetchImage(url: string, tabUrl: string | undefined): Promise<string> {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('只能抓取 http(s) 图片');
  const sameOrigin = tabUrl ? new URL(tabUrl).origin === u.origin : false;
  const res = await fetch(u.href, {
    credentials: sameOrigin ? 'include' : 'omit',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`下载答卷图片失败（HTTP ${res.status}）`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('目标不是图片');
  const blob = await res.blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('答卷图片过大');
  return blobToDataUrl(blob);
}

// ---------- 站点启用：动态注册内容脚本 ----------

const scriptIds = (origin: string) => ({ main: `eg-main:${origin}`, insert: `eg-insert:${origin}` });

async function registerSite(origin: string) {
  const pattern = `${origin}/*`;
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) throw new Error('尚未授权访问该站点');
  const ids = scriptIds(origin);
  const existing = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  const scripts: chrome.scripting.RegisteredContentScript[] = [
    { id: ids.insert, matches: [pattern], js: ['insert.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
    { id: ids.main, matches: [pattern], js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true },
  ];
  for (const s of scripts) {
    if (existing.has(s.id)) await chrome.scripting.updateContentScripts([s]);
    else await chrome.scripting.registerContentScripts([s]);
  }
  const sites = new Set((await store.get()).sites ?? []);
  sites.add(origin);
  await store.set({ sites: [...sites] });
}

async function unregisterSite(origin: string) {
  const ids = scriptIds(origin);
  const existing = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  const toRemove = [ids.main, ids.insert].filter((id) => existing.has(id));
  if (toRemove.length) await chrome.scripting.unregisterContentScripts({ ids: toRemove });
  await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false);
  const sites = ((await store.get()).sites ?? []).filter((s) => s !== origin);
  await store.set({ sites });
}

/** 浏览器重启/扩展更新后，补回丢失的注册（用户撤销了权限的站点会被移除） */
async function repairSites() {
  const sites = (await store.get()).sites ?? [];
  for (const origin of sites) {
    try {
      await registerSite(origin);
    } catch {
      await unregisterSite(origin);
    }
  }
}

// ---------- 命令路由 ----------

type Sender = chrome.runtime.MessageSender;

async function handle(req: BgRequest, sender: Sender): Promise<unknown> {
  switch (req.cmd) {
    case 'auth.status': {
      const { token, user } = await store.get();
      if (!token) return { user: null };
      try {
        const fresh = await api<PublicUser>('GET', '/api/auth/me');
        await store.set({ user: fresh });
        return { user: fresh };
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) return { user: user ?? null, offline: true };
        return { user: null };
      }
    }
    case 'auth.login':
    case 'auth.register': {
      const path = req.cmd === 'auth.login' ? '/api/auth/login' : '/api/auth/register';
      const r = await api<{ token: string; user: PublicUser }>('POST', path, {
        username: req.username,
        password: req.password,
        ...(req.cmd === 'auth.register' ? { inviteToken: req.inviteToken } : {}),
      });
      await store.set({ token: r.token, user: r.user });
      return { user: r.user };
    }
    case 'auth.logout':
      await store.remove(['token', 'user', 'flags']);
      return {};
    case 'billing.redeem':
      return api('POST', '/api/billing/redeem', { code: req.code });
    case 'settings.get':
      return settings();
    case 'settings.set': {
      const cur = (await store.get()).settings ?? {};
      const next = { ...cur, ...req.settings };
      if (__DEV__) {
        if (next.serverUrl) {
          const u = new URL(next.serverUrl);
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error('服务端地址必须是 http(s)');
          next.serverUrl = u.origin;
        }
      } else {
        // 发布版：服务端地址固定，任何来源的修改都忽略
        delete next.serverUrl;
      }
      await store.set({ settings: next });
      return settings();
    }
    case 'meta.get':
      return api('GET', '/api/meta');
    case 'flags.get':
      return getFlags(req.refresh ?? false);
    case 'adapter.resolve':
      return api('GET', `/api/adapters/resolve?${qs({ host: req.host, path: req.path })}`);
    case 'adapter.save':
      return api('POST', '/api/adapters/mine', {
        name: req.name,
        hostPattern: req.hostPattern,
        pathPattern: req.pathPattern,
        config: req.config,
      });
    case 'task.lookup':
      return api('GET', `/api/tasks/lookup?${qs({ platformHost: req.platformHost, exam: req.exam, q_index: req.q_index })}`);
    case 'task.upsert':
      return api('PUT', '/api/tasks', req.task);
    case 'judge.run':
      // 服务端单次模型超时 60s、默认最多重试 2 次，这里要留够 3 次尝试的时间
      return api('POST', '/api/judge', { taskId: req.taskId, image: req.image, force: req.force ?? false }, 240000);
    case 'record.confirm':
      return api('POST', `/api/records/${encodeURIComponent(req.gradingId)}/confirm`, {
        modifiedScore: req.modifiedScore,
        isAuto: req.isAuto,
      });
    case 'image.fetch':
      if (!sender.tab) throw new Error('只能由页面发起');
      return fetchImage(req.url, sender.tab.url);
    case 'tab.capture': {
      if (!sender.tab?.windowId) throw new Error('只能由页面发起');
      try {
        return await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      } catch {
        throw new Error('截图失败：请先点击浏览器工具栏上的 Easy Grader 图标授权当前页面，再重试');
      }
    }
    case 'site.list':
      return (await store.get()).sites ?? [];
    case 'site.enable':
      await registerSite(new URL(req.origin).origin);
      return {};
    case 'site.disable':
      await unregisterSite(new URL(req.origin).origin);
      return {};
    default: {
      const never: never = req;
      throw new Error(`未知命令：${(never as { cmd?: string }).cmd}`);
    }
  }
}

chrome.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse: (r: BgResponse) => void) => {
  // 只接受本扩展自身（内容脚本 / popup）发来的消息
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.cmd !== 'string') return false;
  handle(msg, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e: Error) => sendResponse({ ok: false, error: e.message || String(e), status: (e as ApiError).status }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => void repairSites());
chrome.runtime.onStartup.addListener(() => void repairSites());
chrome.permissions.onRemoved.addListener(() => void repairSites());
