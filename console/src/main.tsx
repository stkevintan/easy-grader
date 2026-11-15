import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router';
import { queryClient } from './api/client';
import { RequireAuth, Shell } from './layout/shell';
import { AccountPage } from './pages/account';
import { AdaptersPage } from './pages/adapters';
import { CreditsPage } from './pages/credits';
import { HomePage } from './pages/home';
import { LoginPage } from './pages/login';
import { RecordDetailPage, RecordsPage } from './pages/records';
import { TasksPage } from './pages/tasks';
import './index.css';

const router = createHashRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Shell />,
        children: [
          { path: '/', element: <HomePage /> },
          { path: '/tasks', element: <TasksPage /> },
          { path: '/records', element: <RecordsPage /> },
          { path: '/records/:gradingId', element: <RecordDetailPage /> },
          { path: '/credits', element: <CreditsPage /> },
          { path: '/adapters', element: <AdaptersPage /> },
          { path: '/account', element: <AccountPage /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
