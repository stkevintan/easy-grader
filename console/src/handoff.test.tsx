import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from './api/client';
import { HandoffPage, safeTarget } from './pages/handoff';

const alice = { id: 1, username: 'alice', role: 'user', credits: 3, createdAt: '' };
const bob = { id: 2, username: 'bob', role: 'user', credits: 5, createdAt: '' };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderAt(url: string) {
  const router = createMemoryRouter(
    [
      { path: '/handoff', element: <HandoffPage /> },
      { path: '/credits', element: <p>额度页</p> },
      { path: '/', element: <p>首页</p> },
      { path: '/login', element: <p>登录页</p> },
    ],
    { initialEntries: [url] },
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('从扩展打开控制台（handoff）', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sessionStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('没登录时直接换码登录，跳到 to 指定的页', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { token: 't-alice', user: alice }));
    renderAt('/handoff?code=EGH-test-code-001&to=/credits');
    expect(await screen.findByText('额度页')).toBeInTheDocument();
    expect(session.token()).toBe('t-alice');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/handoff/redeem');
    expect(JSON.parse(init.body)).toEqual({ code: 'EGH-test-code-001' });
    // 换码不带控制台的 token
    expect(init.headers.authorization).toBeUndefined();
  });

  it('控制台登录的是另一个账号时先问；选保持则不换', async () => {
    session.set('t-bob');
    fetchMock
      .mockResolvedValueOnce(json(200, { token: 't-alice', user: alice }))
      .mockResolvedValueOnce(json(200, bob));
    renderAt('/handoff?code=EGH-test-code-002&to=/credits');
    expect(await screen.findByText(/要切换吗/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '保持 bob' }));
    expect(await screen.findByText('额度页')).toBeInTheDocument();
    expect(session.token()).toBe('t-bob');
  });

  it('选切换则换成扩展里的账号', async () => {
    session.set('t-bob');
    fetchMock
      .mockResolvedValueOnce(json(200, { token: 't-alice', user: alice }))
      .mockResolvedValueOnce(json(200, bob));
    renderAt('/handoff?code=EGH-test-code-003&to=/credits');
    await userEvent.click(await screen.findByRole('button', { name: '切换到 alice' }));
    expect(await screen.findByText('额度页')).toBeInTheDocument();
    expect(session.token()).toBe('t-alice');
  });

  it('码无效时显示原因，控制台已有的登录不受影响', async () => {
    session.set('t-bob');
    fetchMock.mockResolvedValueOnce(json(401, { message: '交接码无效或已过期，请从扩展重新打开控制台' }));
    renderAt('/handoff?code=EGH-test-code-004&to=/credits');
    expect(await screen.findByRole('alert')).toHaveTextContent('交接码无效或已过期');
    expect(session.token()).toBe('t-bob');
    await userEvent.click(screen.getByRole('button', { name: '继续使用当前账号' }));
    expect(await screen.findByText('额度页')).toBeInTheDocument();
  });

  it('查当前账号失败（如 500）时保留原登录并提示，不自动切换', async () => {
    session.set('t-bob');
    fetchMock
      .mockResolvedValueOnce(json(200, { token: 't-alice', user: alice }))
      .mockResolvedValueOnce(json(500, { message: 'boom' }));
    renderAt('/handoff?code=EGH-code-five-xx&to=/credits');
    expect(await screen.findByRole('alert')).toHaveTextContent('无法确认控制台当前登录的账号');
    expect(session.token()).toBe('t-bob');
  });

  it('当前登录已失效（401）时按没登录处理，直接换成扩展的账号', async () => {
    session.set('t-old');
    fetchMock
      .mockResolvedValueOnce(json(200, { token: 't-alice', user: alice }))
      .mockResolvedValueOnce(json(401, { message: '登录已失效' }));
    renderAt('/handoff?code=EGH-code-six-xxx&to=/credits');
    expect(await screen.findByText('额度页')).toBeInTheDocument();
    expect(session.token()).toBe('t-alice');
  });

  it('页面被复用时处理新的码：停在出错页时再从扩展打开，用新码登录并跳到新的 to', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { message: '交接码无效或已过期' }))
      .mockResolvedValueOnce(json(200, { token: 't-alice', user: alice }));
    const router = createMemoryRouter(
      [
        { path: '/handoff', element: <HandoffPage /> },
        { path: '/credits', element: <p>额度页</p> },
        { path: '/', element: <p>首页</p> },
      ],
      { initialEntries: ['/handoff?code=EGH-first-code-x&to=/'] },
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('交接码无效');
    await router.navigate('/handoff?code=EGH-second-code&to=/credits');
    expect(await screen.findByText('额度页')).toBeInTheDocument();
    expect(session.token()).toBe('t-alice');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ code: 'EGH-second-code' });
  });

  it('to 只接受站内路径', () => {
    expect(safeTarget('/records/abc?x=1')).toBe('/records/abc?x=1');
    expect(safeTarget('//evil.example')).toBe('/');
    expect(safeTarget('https://evil.example')).toBe('/');
    expect(safeTarget('/\\evil.example')).toBe('/');
    expect(safeTarget(null)).toBe('/');
  });
});
