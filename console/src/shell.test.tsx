import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { RequireAdmin, Shell } from './layout/shell';

function renderAs(role: 'user' | 'admin', path: string) {
  const client = new QueryClient();
  client.setQueryData(['me'], { id: 1, username: 'u', role, credits: 3, createdAt: '' });
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: '/', element: <p>我的首页</p> },
          { element: <RequireAdmin />, children: [{ path: '/admin', element: <p>系统概览</p> }] },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('系统管理入口', () => {
  it('老师看不到系统管理，直接打开 /admin 会回到首页', () => {
    renderAs('user', '/admin');
    expect(screen.queryByText('系统管理')).not.toBeInTheDocument();
    expect(screen.getByText('我的首页')).toBeInTheDocument();
  });

  it('管理员能看到系统管理并打开概览', () => {
    renderAs('admin', '/admin');
    expect(screen.getByText('系统管理')).toBeInTheDocument();
    expect(screen.getByText('系统概览')).toBeInTheDocument();
  });
});
