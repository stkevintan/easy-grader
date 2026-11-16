import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, session } from '../api/client';
import { useMe } from '../api/auth';
import { Button, Card, ErrorText, Field, Input } from '../ui';

export function AccountPage() {
  const me = useMe();
  const [mismatch, setMismatch] = useState(false);
  const change = useMutation({
    mutationFn: async (input: { oldPassword: string; newPassword: string }) => {
      const tokenAtRequest = session.token();
      const r = await api<{ token: string }>('POST', '/api/auth/password', input);
      return { token: r.token, tokenAtRequest };
    },
    // 请求期间用户可能已经退出或换了账号，不能把旧请求的 token 写回去
    onSuccess: (r) => {
      if (session.token() === r.tokenAtRequest) session.set(r.token);
    },
  });
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    if (data.newPassword !== data.confirm) {
      change.reset();
      setMismatch(true);
      return;
    }
    setMismatch(false);
    change.mutate({ oldPassword: data.oldPassword, newPassword: data.newPassword });
  };
  return (
    <div className="flex max-w-md flex-col gap-4">
      <h1 className="text-lg font-semibold">账号</h1>
      <Card>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-slate-500">用户名</dt><dd>{me.data?.username ?? '…'}</dd>
          <dt className="text-slate-500">角色</dt><dd>{me.data?.role === 'admin' ? '系统管理员' : '老师'}</dd>
          <dt className="text-slate-500">所属组织</dt><dd>{me.data ? me.data.org?.name ?? '无' : '…'}</dd>
          <dt className="text-slate-500">注册时间</dt><dd>{me.data ? new Date(me.data.createdAt).toLocaleDateString() : '…'}</dd>
        </dl>
      </Card>
      <Card title="修改密码">
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <Field label="原密码"><Input name="oldPassword" type="password" required minLength={1} maxLength={128} /></Field>
          <Field label="新密码"><Input name="newPassword" type="password" required minLength={8} maxLength={128} /></Field>
          <Field label="再输一次新密码"><Input name="confirm" type="password" required minLength={8} /></Field>
          <ErrorText error={change.error} />
          {mismatch && <p className="text-sm text-red-600">两次输入的新密码不一致</p>}
          {change.isSuccess && <p className="text-sm text-green-600">密码已修改，其他设备上的登录已失效</p>}
          <Button variant="primary" type="submit" disabled={change.isPending}>保存</Button>
        </form>
      </Card>
    </div>
  );
}
