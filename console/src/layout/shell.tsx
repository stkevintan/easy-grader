import { NavLink, Navigate, Outlet, useNavigate } from 'react-router';
import { BookOpen, Coins, Home, KeyRound, ListChecks, LogOut, SlidersHorizontal, UserRound } from 'lucide-react';
import { useLogout, useMe } from '../api/auth';
import { session } from '../api/client';
import { cn } from '../ui';

const NAV = [
  { to: '/', label: '首页', icon: Home },
  { to: '/tasks', label: '阅卷任务', icon: ListChecks },
  { to: '/records', label: '评分记录', icon: BookOpen },
  { to: '/credits', label: '额度', icon: Coins },
  { to: '/adapters', label: '我的适配', icon: SlidersHorizontal },
  { to: '/account', label: '账号', icon: KeyRound },
];

export function RequireAuth() {
  if (!session.token()) return <Navigate to="/login" replace />;
  return <Outlet />;
}

export function Shell() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <div className="flex h-full bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <aside className="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="px-4 py-4 text-base font-semibold">Easy Grader</div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm',
                  isActive ? 'bg-blue-50 font-medium text-brand dark:bg-slate-800' : 'hover:bg-slate-100 dark:hover:bg-slate-800',
                )
              }
            >
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-slate-200 p-3 text-sm dark:border-slate-800">
          <div className="flex items-center gap-2">
            <UserRound size={16} />
            <span className="truncate">{me.data?.username ?? '…'}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            剩余 <button className="text-brand underline" onClick={() => navigate('/credits')}>{me.data?.credits ?? '—'}</button> 次
          </div>
          <button className="mt-2 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800" onClick={logout}>
            <LogOut size={14} /> 退出
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
