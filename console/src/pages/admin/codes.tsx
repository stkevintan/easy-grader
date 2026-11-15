import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { api } from '../../api/client';
import type { AdminCode, AdminInvite, Page } from '../../api/types';
import { Dialog } from '../../dialog';
import { Button, ErrorText } from '../../ui';
import { CopyList, LinkBtn, ListPage, SearchBox, Tag, fmtTime, qs } from './common';

const expired = (s: string | null) => {
  if (!s) return false;
  const str = String(s);
  const d = new Date(str.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? '' : 'Z'));
  return d < new Date();
};

function status(x: { disabled: boolean; expiresAt: string | null; usedCount: number; maxUses: number }) {
  if (x.disabled) return <Tag kind="bad">已停用</Tag>;
  if (expired(x.expiresAt)) return <Tag kind="warn">已过期</Tag>;
  if (x.usedCount >= x.maxUses) return <Tag>已用完</Tag>;
  return <Tag kind="ok">可用</Tag>;
}

/** 日期输入框的值 → 当天 23:59:59（本地时间）的 ISO 字符串 */
const endOfDay = (d: string) => new Date(`${d}T23:59:59`).toISOString();

export function AdminCodesPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const codes = useQuery({
    queryKey: ['admin-codes', page, q],
    queryFn: () => api<Page<AdminCode>>('GET', `/api/admin/codes?${qs({ page, q })}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-codes'] });
  const onSearch = useCallback((v: string) => {
    setQ(v);
    setPage(1);
  }, []);
  const toggle = async (c: AdminCode) => {
    setError(null);
    try {
      await api('PATCH', `/api/admin/codes/${c.id}`, { disabled: !c.disabled });
      refresh();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <ErrorText error={error} />
      <ListPage
        title="兑换码"
        search={<SearchBox placeholder="搜索兑换码或备注" onChange={onSearch} />}
        toolbar={<Button variant="primary" onClick={() => setCreating(true)}>生成兑换码</Button>}
        query={codes}
        rowKey={(c) => c.id}
        page={page}
        onPage={setPage}
        cols={[
          { title: '兑换码', render: (c) => <code>{c.code}</code> },
          { title: '次数', render: (c) => c.credits },
          { title: '已用/上限', render: (c) => `${c.usedCount} / ${c.maxUses}` },
          { title: '状态', render: status },
          { title: '过期时间', render: (c) => fmtTime(c.expiresAt) },
          { title: '备注', render: (c) => c.note || '—', wrap: true },
          { title: '创建时间', render: (c) => fmtTime(c.createdAt) },
          {
            title: '操作',
            render: (c) => (
              <div className="flex gap-3">
                <LinkBtn onClick={() => navigator.clipboard.writeText(c.code)}>复制</LinkBtn>
                <LinkBtn danger={!c.disabled} onClick={() => toggle(c)}>{c.disabled ? '启用' : '停用'}</LinkBtn>
              </div>
            ),
          },
        ]}
      />
      {creating && (
        <Dialog
          title="生成兑换码"
          submitText="生成"
          fields={[
            { name: 'count', label: '生成数量（1-500）', type: 'number', min: 1, max: 500, step: 1, value: 10, required: true },
            { name: 'credits', label: '每个码的次数', type: 'number', min: 1, step: 1, value: 100, required: true },
            { name: 'maxUses', label: '每个码可被几个人使用', type: 'number', min: 1, step: 1, value: 1, hint: '1 表示一人一码；大于 1 适合发给一个教研组共用（每人限兑一次）' },
            { name: 'expiresAt', label: '过期日期（可选）', type: 'date' },
            { name: 'note', label: '备注', maxLength: 200, placeholder: '例如：XX 中学 2026 秋季' },
          ]}
          onSubmit={async (v) => {
            const r = await api<{ codes: string[] }>('POST', '/api/admin/codes', {
              count: Number(v.count),
              credits: Number(v.credits),
              maxUses: Number(v.maxUses) || 1,
              expiresAt: v.expiresAt ? endOfDay(String(v.expiresAt)) : undefined,
              note: v.note || undefined,
            });
            refresh();
            setCreated(r.codes);
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {created && (
        <Dialog title={`已生成 ${created.length} 个兑换码`} extra={<CopyList lines={created} />} onClose={() => setCreated(null)} />
      )}
    </>
  );
}

interface Unit {
  id: number;
  name: string;
  enabled: boolean;
}

export function AdminInvitesPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [created, setCreated] = useState<{ id: number; token: string }[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const invites = useQuery({
    queryKey: ['admin-invites', page, q],
    queryFn: () => api<Page<AdminInvite>>('GET', `/api/admin/invites?${qs({ page, q, pageSize: 20 })}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-invites'] });
  const onSearch = useCallback((v: string) => {
    setQ(v);
    setPage(1);
  }, []);
  const openCreate = async () => {
    setError(null);
    try {
      const list = (await api<Unit[]>('GET', '/api/admin/units')).filter((u) => u.enabled);
      if (!list.length) throw new Error('还没有可用的管理单元，暂时不能生成邀请令牌');
      setUnits(list);
    } catch (e) {
      setError(e);
    }
  };
  const toggle = async (x: AdminInvite) => {
    setError(null);
    try {
      await api('PATCH', `/api/admin/invites/${x.id}`, { disabled: !x.disabled });
      refresh();
    } catch (e) {
      setError(e);
    }
  };
  const defaultExpiry = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

  return (
    <>
      <ErrorText error={error} />
      <ListPage
        title="邀请令牌"
        search={<SearchBox placeholder="搜索备注" onChange={onSearch} />}
        toolbar={<Button variant="primary" onClick={openCreate}>生成邀请令牌</Button>}
        query={invites}
        rowKey={(x) => x.id}
        page={page}
        onPage={setPage}
        cols={[
          { title: 'ID', render: (x) => x.id },
          { title: '单元', render: (x) => x.unitId },
          { title: '已用/上限', render: (x) => `${x.usedCount} / ${x.maxUses}` },
          { title: '状态', render: status },
          { title: '过期时间', render: (x) => fmtTime(x.expiresAt) },
          { title: '备注', render: (x) => x.note || '—', wrap: true },
          { title: '操作', render: (x) => <LinkBtn danger={!x.disabled} onClick={() => toggle(x)}>{x.disabled ? '启用' : '停用'}</LinkBtn> },
        ]}
      />
      {units && (
        <Dialog
          title="生成邀请令牌"
          submitText="生成"
          fields={[
            { name: 'unitId', label: '管理单元', type: 'select', options: units.map((u) => [String(u.id), u.name]) },
            { name: 'count', label: '生成数量', type: 'number', min: 1, max: 500, value: 1, required: true },
            { name: 'maxUses', label: '每个令牌可注册人数', type: 'number', min: 1, max: 100000, value: 10, required: true },
            { name: 'credits', label: '每个账号默认额度', type: 'number', min: 0, max: 1000000, value: 20, required: true },
            { name: 'expiresAt', label: '过期日期', type: 'date', required: true, value: defaultExpiry },
            { name: 'note', label: '备注', maxLength: 200 },
          ]}
          onSubmit={async (v) => {
            const count = Number(v.count);
            const maxUses = Number(v.maxUses);
            const credits = Number(v.credits);
            if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('生成数量必须是 1-500 的整数');
            if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000) throw new Error('每个令牌可注册人数必须是 1-100000 的整数');
            if (!Number.isInteger(credits) || credits < 0 || credits > 1000000) throw new Error('默认额度必须是 0-1000000 的整数');
            if (!v.expiresAt) throw new Error('请选择过期日期');
            const expiry = new Date(`${v.expiresAt}T23:59:59`);
            if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) throw new Error('过期日期必须晚于当前时间');
            const r = await api<{ tokens: { id: number; token: string }[] }>('POST', '/api/admin/invites', {
              unitId: Number(v.unitId),
              count,
              maxUses,
              credits,
              expiresAt: expiry.toISOString(),
              note: v.note || undefined,
            });
            refresh();
            setCreated(r.tokens);
          }}
          onClose={() => setUnits(null)}
        />
      )}
      {created && (
        <Dialog title={`已生成 ${created.length} 个邀请令牌`} extra={<CopyList lines={created.map((x) => x.token)} />} onClose={() => setCreated(null)} />
      )}
    </>
  );
}
