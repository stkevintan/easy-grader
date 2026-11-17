import { NavLink, Navigate, Outlet, useNavigate } from 'react-router';
import {
  BarChart3,
  BookOpen,
  Building2,
  Coins,
  FileText,
  Gift,
  Home,
  KeyRound,
  ListChecks,
  LogOut,
  Mail,
  Cpu,
  ScrollText,
  SlidersHorizontal,
  ToggleLeft,
  UserRound,
  Users,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useLogout, useMe } from '../api/auth';
import { session } from '../api/client';
import { cn } from '../ui';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
}

const MINE: NavItem[] = [
  { to: '/', label: '首页', icon: Home },
  { to: '/tasks', label: '阅卷任务', icon: ListChecks },
  { to: '/records', label: '评分记录', icon: BookOpen },
  { to: '/credits', label: '额度', icon: Coins },
  { to: '/adapters', label: '我的适配', icon: SlidersHorizontal },
  { to: '/account', label: '账号', icon: KeyRound },
];

const ADMIN: NavItem[] = [
  { to: '/admin', label: '概览', icon: BarChart3 },
  { to: '/admin/users', label: '用户', icon: Users },
  { to: '/admin/orgs', label: '组织', icon: Building2 },
  { to: '/admin/codes', label: '兑换码', icon: Gift },
  { to: '/admin/invites', label: '邀请令牌', icon: Mail },
  { to: '/admin/records', label: '评分记录', icon: FileText },
  { to: '/admin/presets', label: '适配预设', icon: SlidersHorizontal },
  { to: '/admin/ledger', label: '额度流水', icon: ScrollText },
  { to: '/admin/flags', label: '功能开关', icon: ToggleLeft },
  { to: '/admin/model', label: '模型', icon: Cpu },
];

export function RequireAuth() {
  if (!session.token()) return <Navigate to="/login" replace />;
  return <Outlet />;
}

export function RequireAdmin() {
  const me = useMe();
  if (me.isLoading) return null;
  if (me.data?.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}

function NavGroup({ title, items }: { title?: string; items: NavItem[] }) {
  return (
    <div className="mt-2">
      {title && <div className="px-3 pb-1 pt-2 text-xs font-medium text-slate-400">{title}</div>}
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/' || to === '/admin'}
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
    </div>
  );
}

export function Shell() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const isAdmin = me.data?.role === 'admin';
  return (
    <div className="flex h-full bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <aside className="flex w-52 shrink-0 flex-col overflow-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="px-4 py-4 text-base font-semibold">Easy Grader</div>
        <nav className="flex flex-col px-2">
          <NavGroup items={MINE} />
          {isAdmin && <NavGroup title="系统管理" items={ADMIN} />}
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
