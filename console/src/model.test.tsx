import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminModelPage } from './pages/admin/model';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const info = (over: Record<string, unknown> = {}) => ({
  name: 'qwen-vl-max',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyConfigured: true,
  ready: true,
  params: {
    timeoutMs: 60000,
    temperature: 0.1,
    maxTokens: 8000,
    reasoningEffort: 'low',
    maxRetries: 2,
    retryDelayMs: 800,
    scoreWithImage: true,
    sampleCount: 1,
    ocrTwoPass: true,
    maxImageBytes: 4 * 1024 * 1024,
  },
  profiles: [{ name: 'fast', overrides: ['name', 'reasoningEffort'] }],
  gold: { enabled: false, maxExamples: 4 },
  overrides: [],
  updated: { at: null, byName: '' },
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

  it('显示当前模型、参数和近 7 天各模型评分', async () => {
    fetchMock.mockImplementation(async () => json(200, info()));
    renderPage();
    const names = await screen.findAllByText('qwen-vl-max');
    expect(names.length).toBeGreaterThan(0);
    expect(screen.getByText('已就绪')).toBeInTheDocument();
    expect(screen.getByText(/并行采样次数/)).toBeInTheDocument();
    expect(screen.getByText('fast')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('改模型名后保存，只提交改动的字段', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return json(200, info({ overrides: ['name'] }));
      return json(200, info());
    });
    renderPage();
    const input = await screen.findByDisplayValue('qwen-vl-max');
    await userEvent.clear(input);
    await userEvent.type(input, 'deepseek-flash');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]?.body))).toEqual({ name: 'deepseek-flash' });
    expect(await screen.findByText(/下一次评分就用新配置/)).toBeInTheDocument();
  });

  it('没配 API Key 时直接提示评分为 mock', async () => {
    fetchMock.mockImplementation(async () => json(200, info({ apiKeyConfigured: false, ready: false, usage: [] })));
    renderPage();
    expect(await screen.findByText(/评分走 mock，分数是假的/)).toBeInTheDocument();
    expect(screen.getByText('不可用')).toBeInTheDocument();
    expect(screen.getByText('近 7 天还没有评分记录')).toBeInTheDocument();
  });
});
