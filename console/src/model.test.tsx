import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminModelPage } from './pages/admin/model';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const profile = (over: Record<string, unknown> = {}) => ({
  name: 'default',
  model: 'qwen-vl-max',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyConfigured: true,
  params: {
    temperature: 0.1,
    maxTokens: 8000,
    reasoningEffort: 'low',
    sampleCount: 1,
    scoreWithImage: true,
    timeoutMs: 60000,
  },
  overrides: ['model'],
  vision: { ok: true, checkedAt: '2026-11-17T08:00:00.000Z', error: '' },
  updated: { at: '2026-11-17T08:00:00.000Z', byName: 'admin' },
  ready: true,
  envBacked: false,
  ...over,
});

const info = (over: Record<string, unknown> = {}) => ({
  profiles: [profile(), profile({ name: 'fast', model: 'qwen-vl-plus', overrides: [] })],
  fixed: { maxRetries: 2, retryDelayMs: 800, ocrTwoPass: true, maxImageBytes: 4 * 1024 * 1024 },
  gold: { enabled: false, maxExamples: 4 },
  usage: [{ model: 'qwen-vl-max', total: 12, done: 11, failed: 1, avgLatencyMs: 4321 }],
  ...over,
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AdminModelPage />
    </QueryClientProvider>,
  );
}

describe('管理端模型页', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('列出多个方案、视觉状态和近 7 天评分', async () => {
    fetchMock.mockImplementation(async () => json(200, info()));
    renderPage();
    expect(await screen.findByText('fast')).toBeInTheDocument();
    expect(screen.getAllByText('可读图')).toHaveLength(2);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增方案' })).toBeInTheDocument();
  });

  it('默认模型不可用时明确提示会是 mock 分', async () => {
    fetchMock.mockImplementation(async () => json(200, info({ profiles: [profile({ apiKeyConfigured: false, ready: false })] })));
    renderPage();
    expect(await screen.findByText('默认模型不可用')).toBeInTheDocument();
    expect(screen.getByText(/分数是假的/)).toBeInTheDocument();
  });

  it('测试读图会调后端并显示结果', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json(201, profile({ name: 'fast', vision: { ok: false, checkedAt: null, error: 'image_url is not supported' } }));
      return json(200, info());
    });
    renderPage();
    await screen.findByText('fast');
    await userEvent.click(screen.getAllByText('测试读图')[1]);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/api/admin/model/fast/test'))).toBe(true));
    expect(await screen.findByText(/「fast」读不了图/)).toBeInTheDocument();
  });
});
