import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router';
import { queryClient } from './api/client';
import { RequireAdmin, RequireAuth, Shell } from './layout/shell';
import { AccountPage } from './pages/account';
import { AdaptersPage } from './pages/adapters';
import { CreditsPage } from './pages/credits';
import { HomePage } from './pages/home';
import { LoginPage } from './pages/login';
import { RecordDetailPage, RecordsPage } from './pages/records';
import { TasksPage } from './pages/tasks';
import { AdminCodesPage, AdminInvitesPage } from './pages/admin/codes';
import { AdminFlagsPage } from './pages/admin/flags';
import { AdminHomePage } from './pages/admin/home';
import { AdminPresetsPage } from './pages/admin/presets';
import { AdminOrgsPage } from './pages/admin/orgs';
import { AdminLedgerPage, AdminRecordsPage } from './pages/admin/records';
import { AdminUsersPage } from './pages/admin/users';
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
          {
            element: <RequireAdmin />,
            children: [
              { path: '/admin', element: <AdminHomePage /> },
              { path: '/admin/users', element: <AdminUsersPage /> },
              { path: '/admin/orgs', element: <AdminOrgsPage /> },
              { path: '/admin/codes', element: <AdminCodesPage /> },
              { path: '/admin/invites', element: <AdminInvitesPage /> },
              { path: '/admin/records', element: <AdminRecordsPage /> },
              { path: '/admin/presets', element: <AdminPresetsPage /> },
              { path: '/admin/ledger', element: <AdminLedgerPage /> },
              { path: '/admin/flags', element: <AdminFlagsPage /> },
            ],
          },
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
