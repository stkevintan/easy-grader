import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMe } from '../../api/auth';
import { api } from '../../api/client';
import type { AdminUser, Page } from '../../api/types';
import { Confirm, Dialog } from '../../dialog';
import { Button } from '../../ui';
import { LinkBtn, ListPage, SearchBox, Tag, fmtTime, qs } from './common';

type Modal =
  | { kind: 'create' }
  | { kind: 'adjust'; user: AdminUser }
  | { kind: 'password'; user: AdminUser }
  | { kind: 'toggle'; user: AdminUser }
  | { kind: 'role'; user: AdminUser };

export function AdminUsersPage() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState<Modal | null>(null);
  const [notice, setNotice] = useState('');
  const users = useQuery({
    queryKey: ['admin-users', page, q],
    queryFn: () => api<Page<AdminUser>>('GET', `/api/admin/users?${qs({ page, q })}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] });
  const onSearch = useCallback((v: string) => {
    setQ(v);
    setPage(1);
  }, []);
  const close = () => setModal(null);

  return (
    <>
      {notice && <p className="mb-2 text-sm text-green-600">{notice}</p>}
      <ListPage
        title="用户"
        search={<SearchBox placeholder="搜索用户名" onChange={onSearch} />}
        toolbar={<Button variant="primary" onClick={() => setModal({ kind: 'create' })}>新建用户</Button>}
        query={users}
        rowKey={(u) => u.id}
        page={page}
        onPage={setPage}
        cols={[
          { title: 'ID', render: (u) => u.id },
          {
            title: '用户名',
            render: (u) => (
              <span>
                {u.username} {u.role === 'admin' && <Tag kind="brand">管理员</Tag>}
                {u.disabled && <Tag kind="bad">已停用</Tag>}
              </span>
            ),
          },
          { title: '剩余次数', render: (u) => u.credits },
          { title: '已评分', render: (u) => u.judged },
          { title: '最近评分', render: (u) => fmtTime(u.lastJudgeAt) },
          { title: '最近登录', render: (u) => fmtTime(u.lastLoginAt) },
          { title: '注册时间', render: (u) => fmtTime(u.createdAt) },
          {
            title: '操作',
            render: (u) => {
              const self = me.data?.id === u.id;
              return (
                <div className="flex gap-3">
                  <LinkBtn onClick={() => setModal({ kind: 'adjust', user: u })}>调额度</LinkBtn>
                  <LinkBtn onClick={() => navigate(`/admin/ledger?userId=${u.id}`)}>流水</LinkBtn>
                  <LinkBtn onClick={() => setModal({ kind: 'password', user: u })}>重置密码</LinkBtn>
                  {!self && (
                    <LinkBtn onClick={() => setModal({ kind: 'role', user: u })}>{u.role === 'admin' ? '取消管理员' : '设为管理员'}</LinkBtn>
                  )}
                  {!self && (
                    <LinkBtn danger={!u.disabled} onClick={() => setModal({ kind: 'toggle', user: u })}>{u.disabled ? '启用' : '停用'}</LinkBtn>
                  )}
                </div>
              );
            },
          },
        ]}
      />
      {modal?.kind === 'create' && (
        <Dialog
          title="新建用户"
          fields={[
            { name: 'username', label: '用户名（3-32 位）', required: true, maxLength: 32 },
            { name: 'password', label: '初始密码（至少 8 位）', type: 'password', required: true },
            { name: 'credits', label: '初始次数', type: 'number', min: 0, step: 1, value: 0 },
            { name: 'role', label: '角色', type: 'select', options: [['user', '普通用户'], ['admin', '管理员']] },
          ]}
          onSubmit={async (v) => {
            await api('POST', '/api/admin/users', {
              username: String(v.username).trim(),
              password: v.password,
              credits: Number(v.credits) || 0,
              role: v.role,
            });
            setNotice('已创建');
            refresh();
          }}
          onClose={close}
        />
      )}
      {modal?.kind === 'adjust' && (
        <Dialog
          title={`调整额度：${modal.user.username}`}
          fields={[
            { name: 'delta', label: `增减次数（当前 ${modal.user.credits}，负数为扣减）`, type: 'number', required: true, step: 1, value: 50 },
            { name: 'note', label: '备注', maxLength: 200, placeholder: '例如：学校采购 / 补偿' },
          ]}
          onSubmit={async (v) => {
            const delta = Number(v.delta);
            if (!Number.isInteger(delta) || delta === 0) throw new Error('请输入非零整数');
            const r = await api<{ balance: number }>('POST', `/api/admin/users/${modal.user.id}/credits`, { delta, note: v.note || undefined });
            setNotice(`已调整，${modal.user.username} 当前余额 ${r.balance}`);
            refresh();
          }}
          onClose={close}
        />
      )}
      {modal?.kind === 'password' && (
        <Dialog
          title={`重置密码：${modal.user.username}`}
          fields={[{ name: 'password', label: '新密码（至少 8 位）', type: 'password', required: true }]}
          onSubmit={async (v) => {
            await api('PATCH', `/api/admin/users/${modal.user.id}`, { password: v.password });
            setNotice('密码已重置，该用户需要重新登录');
          }}
          onClose={close}
        />
      )}
      {modal?.kind === 'toggle' && (
        <Confirm
          title={modal.user.disabled ? '启用账号' : '停用账号'}
          text={modal.user.disabled ? `确定启用 ${modal.user.username}？` : `停用后 ${modal.user.username} 会立即被登出且无法登录，确定？`}
          onOk={async () => {
            await api('PATCH', `/api/admin/users/${modal.user.id}`, { disabled: !modal.user.disabled });
            setNotice(modal.user.disabled ? '已启用' : '已停用');
            refresh();
          }}
          onClose={close}
        />
      )}
      {modal?.kind === 'role' && (
        <Confirm
          title="修改角色"
          text={modal.user.role === 'admin' ? `取消 ${modal.user.username} 的管理员权限？` : `把 ${modal.user.username} 设为管理员？管理员可以管理所有用户和额度。`}
          onOk={async () => {
            await api('PATCH', `/api/admin/users/${modal.user.id}`, { role: modal.user.role === 'admin' ? 'user' : 'admin' });
            setNotice('角色已修改');
            refresh();
          }}
          onClose={close}
        />
      )}
    </>
  );
}
