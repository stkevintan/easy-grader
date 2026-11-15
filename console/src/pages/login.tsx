import { useState } from 'react';
import { Navigate } from 'react-router';
import { useLogin, useRegister } from '../api/auth';
import { session } from '../api/client';
import { Button, Card, ErrorText, Field, Input } from '../ui';

export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const login = useLogin();
  const register = useRegister();
  if (session.token()) return <Navigate to="/" replace />;

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    if (mode === 'login') login.mutate({ username: data.username, password: data.password });
    else register.mutate({ username: data.username, password: data.password, inviteToken: data.inviteToken });
  };
  const pending = login.isPending || register.isPending;
  const error = login.error ?? register.error;

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-950 dark:text-slate-100">
      <Card title={mode === 'login' ? '登录 Easy Grader' : '注册账号'}>
        <form className="flex w-80 flex-col gap-3" onSubmit={onSubmit}>
          <Field label="用户名"><Input name="username" autoComplete="username" required maxLength={32} /></Field>
          <Field label="密码"><Input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} maxLength={128} /></Field>
          {mode === 'register' && (
            <Field label="邀请令牌"><Input name="inviteToken" required minLength={10} maxLength={80} placeholder="由管理员发放" /></Field>
          )}
          <ErrorText error={error} />
          <Button variant="primary" type="submit" disabled={pending}>{pending ? '请稍候…' : mode === 'login' ? '登录' : '注册'}</Button>
          <button
            type="button"
            className="text-sm text-brand"
            onClick={() => { login.reset(); register.reset(); setMode(mode === 'login' ? 'register' : 'login'); }}
          >
            {mode === 'login' ? '没有账号？用邀请令牌注册' : '已有账号？返回登录'}
          </button>
        </form>
      </Card>
    </div>
  );
}
