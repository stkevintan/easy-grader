import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ApiError, session } from '../api/client';
import type { User } from '../api/types';
import { Button, Card } from '../ui';

/** 只跳站内路径：/ 开头、不是 //；其他一律回首页 */
export const safeTarget = (to: string | null) => (to && /^\/(?!\/)/.test(to) && !to.includes('\\') ? to : '/');

/**
 * 换码不带当前控制台的 token：码无效时服务端回 401，不能因此把控制台里已登录的账号踢下线
 */
async function redeem(code: string): Promise<{ token: string; user: User }> {
  const res = await fetch('/api/auth/handoff/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = (await res.json().catch(() => null)) as { message?: string | string[]; token?: string; user?: User } | null;
  if (!res.ok || !data?.token || !data.user) {
    const m = data?.message;
    throw new ApiError(res.status, (Array.isArray(m) ? m.join('；') : m) || `请求失败（${res.status}）`);
  }
  return { token: data.token, user: data.user };
}

/**
 * 控制台当前登录的账号。只有明确的 401（登录已失效）才算没有登录；
 * 网络故障、5xx 等抛错，由调用方保留原登录并提示，不能当成没登录直接切换。
 * 也不走 api()：它遇到 401 会跳去登录页。
 */
async function currentUser(token: string): Promise<User | null> {
  const res = await fetch('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, `无法确认控制台当前登录的账号（${res.status}），已保留当前登录，请稍后从扩展重新打开`);
  return (await res.json()) as User;
}

/** 处理过的码：StrictMode 下 effect 会跑两次，码只能用一次，同一个码只换一回 */
const handled = new Set<string>();

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; to: string }
  | { kind: 'conflict'; current: User; next: { token: string; user: User }; to: string };

/**
 * 从扩展打开控制台：#/handoff?code=…&to=/credits
 * 用一次性交接码换登录。控制台里已经登录了另一个账号时，先问要不要切换。
 */
export function HandoffPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [state, setState] = useState<State>({ kind: 'loading' });
  // 每个新的交接地址开始处理时 +1；旧请求回来时发现代数变了就作废
  const generation = useRef(0);
  const code = params.get('code') ?? '';
  const to = safeTarget(params.get('to'));

  const finish = (token: string, user: User, target: string) => {
    session.set(token);
    qc.clear();
    qc.setQueryData(['me'], user);
    navigate(target, { replace: true });
  };

  // 扩展复用已开的控制台标签页时只改 hash，这个页面会被复用：按每个新的码重新处理
  useEffect(() => {
    if (!code) {
      if (generation.current === 0) setState({ kind: 'error', message: '链接里没有交接码', to });
      return;
    }
    // 换码之前先把码从地址栏和历史里去掉
    history.replaceState(null, '', `${location.pathname}${location.search}#/handoff`);
    if (handled.has(code)) return;
    handled.add(code);
    const gen = ++generation.current;
    const stillCurrent = () => gen === generation.current;
    setState({ kind: 'loading' });
    (async () => {
      const next = await redeem(code);
      const token = session.token();
      const current = token ? await currentUser(token) : null;
      if (!stillCurrent()) return;
      if (current && current.id !== next.user.id) setState({ kind: 'conflict', current, next, to });
      else finish(next.token, next.user, to);
    })().catch((e: unknown) => {
      if (stillCurrent()) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e), to });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, to]);

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <Card title="从扩展打开控制台">
          {state.kind === 'loading' && <p className="text-sm text-slate-500">正在登录…</p>}
          {state.kind === 'error' && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-red-600" role="alert">{state.message}</p>
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => navigate(session.token() ? state.to : '/login', { replace: true })}>
                  {session.token() ? '继续使用当前账号' : '去登录'}
                </Button>
              </div>
            </div>
          )}
          {state.kind === 'conflict' && (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                控制台当前登录的是 <b>{state.current.username}</b>，扩展里登录的是 <b>{state.next.user.username}</b>。要切换吗？
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => finish(state.next.token, state.next.user, state.to)}>
                  切换到 {state.next.user.username}
                </Button>
                <Button onClick={() => navigate(state.to, { replace: true })}>保持 {state.current.username}</Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
