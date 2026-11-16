import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksPage } from './pages/tasks';

const task = (id: number, exam: string) => ({
  taskId: id, judgeId: '', platformHost: 'p.example', scoreStep: 1, judged: 0, confirmed: 0,
  exam: { exam, subject: '语文', q_index: '1' },
  question: { type: '其他', content: { score: 6 } },
  majorInput: { key: 'command', name: '评分标准', content: '' },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function renderAt(url: string) {
  const router = createMemoryRouter([{ path: '/tasks', element: <TasksPage /> }], { initialEntries: [url] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('阅卷任务页按 taskId 定位', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('要看的题不在最近 200 题里时单独取来，并高亮', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/tasks' ? json(200, [task(2, '期末')]) : json(200, task(1, '期中')),
    );
    renderAt('/tasks?taskId=1');
    expect(await screen.findByText(/期中/)).toBeInTheDocument();
    expect(document.querySelector('[data-task="1"]')?.className).toContain('ring-2');
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain('/api/tasks/1');
  });

  it('取不到（已删除或不是自己的）时提示', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/tasks' ? json(200, [task(2, '期末')]) : json(404, { message: '任务不存在' }),
    );
    renderAt('/tasks?taskId=9');
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到要查看的题（#9）');
    expect(screen.getByText(/期末/)).toBeInTheDocument();
  });

  it('在列表里的题不再单独请求', async () => {
    fetchMock.mockResolvedValue(json(200, [task(2, '期末')]));
    renderAt('/tasks?taskId=2');
    expect(await screen.findByText(/期末/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/tasks']);
  });
});
