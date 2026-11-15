import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { LoginPage } from './pages/login';

describe('登录页', () => {
  it('默认显示登录，可以切到注册', async () => {
    const router = createMemoryRouter([{ path: '/login', element: <LoginPage /> }], { initialEntries: ['/login'] });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(screen.queryByLabelText('邀请令牌')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('没有账号？用邀请令牌注册'));
    expect(screen.getByLabelText('邀请令牌')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注册' })).toBeInTheDocument();
  });
});
