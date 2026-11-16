import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client';
import type { AdminOrg, OrgMember } from '../../api/types';
import { Confirm, Dialog } from '../../dialog';
import { Button, Empty, ErrorText } from '../../ui';
import { LinkBtn, ListPage, Table, Tag, fmtTime } from './common';

type Modal =
  | { kind: 'edit'; org: AdminOrg | null }
  | { kind: 'toggle'; org: AdminOrg }
  | { kind: 'members'; org: AdminOrg };

export function AdminOrgsPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<Modal | null>(null);
  const orgs = useQuery({ queryKey: ['admin-orgs'], queryFn: () => api<AdminOrg[]>('GET', '/api/admin/orgs') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-orgs'] });
  const close = () => setModal(null);
  return (
    <>
      <ListPage
        title="组织"
        toolbar={
          <>
            <span className="text-xs text-slate-500">组织只是分组：用来按学校发邀请、设功能开关、筛选统计。组织里的人没有额外权限。</span>
            <Button variant="primary" onClick={() => setModal({ kind: 'edit', org: null })}>新建组织</Button>
          </>
        }
        query={orgs}
        rowKey={(o) => o.id}
        empty="还没有组织"
        cols={[
          { title: 'ID', render: (o) => o.id },
          { title: '名称', render: (o) => o.name },
          { title: '说明', render: (o) => o.description || '—', wrap: true },
          { title: '成员', render: (o) => o.memberCount },
          { title: '状态', render: (o) => (o.enabled ? <Tag kind="ok">启用</Tag> : <Tag kind="bad">停用</Tag>) },
          { title: '创建时间', render: (o) => fmtTime(o.createdAt) },
          {
            title: '操作',
            render: (o) => (
              <div className="flex gap-3">
                <LinkBtn onClick={() => setModal({ kind: 'members', org: o })}>成员</LinkBtn>
                <LinkBtn onClick={() => setModal({ kind: 'edit', org: o })}>编辑</LinkBtn>
                <LinkBtn danger={o.enabled} onClick={() => setModal({ kind: 'toggle', org: o })}>{o.enabled ? '停用' : '启用'}</LinkBtn>
              </div>
            ),
          },
        ]}
      />
      {modal?.kind === 'edit' && (
        <Dialog
          title={modal.org ? `编辑组织：${modal.org.name}` : '新建组织'}
          fields={[
            { name: 'name', label: '名称', required: true, maxLength: 100, value: modal.org?.name },
            { name: 'description', label: '说明', maxLength: 500, value: modal.org?.description },
          ]}
          onSubmit={async (v) => {
            const body = { name: String(v.name).trim(), description: String(v.description).trim() };
            if (modal.org) await api('PATCH', `/api/admin/orgs/${modal.org.id}`, body);
            else await api('POST', '/api/admin/orgs', body);
            refresh();
          }}
          onClose={close}
        />
      )}
      {modal?.kind === 'toggle' && (
        <Confirm
          title={modal.org.enabled ? '停用组织' : '启用组织'}
          text={
            modal.org.enabled
              ? `停用「${modal.org.name}」后，它的邀请令牌不能再用，组织级功能开关不再生效；成员的账号和数据不受影响。确定？`
              : `确定启用「${modal.org.name}」？`
          }
          onOk={async () => {
            await api('PATCH', `/api/admin/orgs/${modal.org.id}`, { enabled: !modal.org.enabled });
            refresh();
          }}
          onClose={close}
        />
      )}
      {modal?.kind === 'members' && <MembersDialog org={modal.org} onClose={close} />}
    </>
  );
}

function MembersDialog({ org, onClose }: { org: AdminOrg; onClose: () => void }) {
  const navigate = useNavigate();
  const members = useQuery({
    queryKey: ['admin-org-members', org.id],
    queryFn: () => api<OrgMember[]>('GET', `/api/admin/orgs/${org.id}/members`),
  });
  return (
    <Dialog
      title={`成员：${org.name}`}
      extra={
        <div className="flex flex-col gap-2">
          <p className="text-xs text-slate-500">在「用户」页给老师改组织，或生成带这个组织的邀请令牌，注册后自动加入。</p>
          <ErrorText error={members.error} />
          {members.isLoading ? (
            <Empty text="加载中…" />
          ) : (
            <Table
              rows={members.data ?? []}
              rowKey={(m) => m.id}
              empty="还没有成员"
              cols={[
                {
                  title: '用户名',
                  render: (m) => (
                    <span>
                      {m.username} {m.role === 'admin' && <Tag kind="brand">管理员</Tag>}
                      {m.disabled && <Tag kind="bad">已停用</Tag>}
                    </span>
                  ),
                },
                { title: '已评分', render: (m) => m.judged },
                { title: '最近评分', render: (m) => fmtTime(m.lastJudgeAt) },
                { title: '剩余次数', render: (m) => m.credits },
                {
                  title: '',
                  render: (m) => (
                    <LinkBtn
                      onClick={() => {
                        onClose();
                        navigate(`/admin/records?userId=${m.id}`);
                      }}
                    >
                      评分记录
                    </LinkBtn>
                  ),
                },
              ]}
            />
          )}
        </div>
      }
      onClose={onClose}
    />
  );
}
