import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../../api/client';
import type { AdminRecord, LedgerItem, Page } from '../../api/types';
import { Button, ledgerReason } from '../../ui';
import { LinkBtn, ListPage, OrgFilter, SearchBox, Tag, fmtNum, fmtTime, qs } from './common';

/** 按用户筛选变化时（含浏览器前进/后退）用 key 重建列表，页码和搜索回到初始 */
export function AdminRecordsPage() {
  const [params] = useSearchParams();
  return <AdminRecordsList key={params.get('userId') ?? ''} />;
}

function AdminRecordsList() {
  const [params] = useSearchParams();
  const userId = params.get('userId');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [orgId, setOrgId] = useState('');
  const records = useQuery({
    queryKey: ['admin-records', page, q, userId, orgId],
    queryFn: () => api<Page<AdminRecord>>('GET', `/api/admin/records?${qs({ page, q, userId, orgId })}`),
  });
  const onSearch = useCallback((v: string) => {
    setQ(v);
    setPage(1);
  }, []);
  return (
    <ListPage
      title={userId ? `评分记录（用户 #${userId}）` : '评分记录'}
      search={
        <>
          <SearchBox placeholder="搜索用户名 / 考试 / 平台" onChange={onSearch} />
          <OrgFilter value={orgId} onChange={(v) => { setOrgId(v); setPage(1); }} />
        </>
      }
      query={records}
      rowKey={(r) => r.id}
      empty="还没有评分记录"
      page={page}
      onPage={setPage}
      cols={[
        { title: 'ID', render: (r) => r.id },
        { title: '时间', render: (r) => fmtTime(r.createdAt) },
        { title: '用户', render: (r) => r.username ?? `#${r.userId}` },
        { title: '考试 / 题号', render: (r) => `${r.examTitle ?? '（已删除）'} · ${r.questionNo ?? ''}`, wrap: true },
        { title: '平台', render: (r) => r.platformHost ?? '—' },
        { title: '状态', render: (r) => (r.status === 'done' ? <Tag kind="ok">成功</Tag> : <span title={r.error}><Tag kind="bad">失败</Tag></span>) },
        { title: 'AI 分', render: (r) => (r.aiScore === null ? '—' : `${fmtNum(r.aiScore)} / ${fmtNum(r.maxScore)}`) },
        {
          title: '终分',
          render: (r) => {
            if (r.finalScore === null) return <span className="text-slate-500">未确认</span>;
            const diff = r.aiScore === null ? 0 : Math.abs(r.finalScore - r.aiScore);
            return (
              <span>
                {fmtNum(r.finalScore)} {diff > 0 && <Tag kind={diff >= 2 ? 'warn' : undefined}>改 {fmtNum(diff)}</Tag>}
              </span>
            );
          },
        },
        { title: '置信度', render: (r) => (r.confidence === null ? '—' : `${Math.round(r.confidence * 100)}%`) },
        { title: '模型', render: (r) => (r.modelProfile && r.modelProfile !== 'default' ? `${r.model || '—'}（${r.modelProfile}）` : r.model || '—') },
        { title: '耗时', render: (r) => `${(r.latencyMs / 1000).toFixed(1)}s` },
        { title: '错误', render: (r) => r.error || '', wrap: true },
      ]}
    />
  );
}

export function AdminLedgerPage() {
  const [params] = useSearchParams();
  return <AdminLedgerList key={params.get('userId') ?? ''} />;
}

function AdminLedgerList() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const userId = params.get('userId');
  const [page, setPage] = useState(1);
  const ledger = useQuery({
    queryKey: ['admin-ledger', page, userId],
    queryFn: () => api<Page<LedgerItem>>('GET', `/api/admin/ledger?${qs({ page, userId })}`),
  });
  return (
    <ListPage
      title={userId ? `额度流水（用户 #${userId}）` : '额度流水'}
      toolbar={userId ? <Button onClick={() => { setPage(1); navigate('/admin/ledger'); }}>查看全部</Button> : undefined}
      query={ledger}
      rowKey={(l) => l.id}
      page={page}
      onPage={setPage}
      cols={[
        { title: 'ID', render: (l) => l.id },
        { title: '时间', render: (l) => fmtTime(l.createdAt) },
        { title: '用户 ID', render: (l) => <LinkBtn onClick={() => { setPage(1); navigate(`/admin/ledger?userId=${l.userId}`); }}>{String(l.userId)}</LinkBtn> },
        { title: '类型', render: (l) => <Tag kind={l.delta > 0 ? 'ok' : undefined}>{ledgerReason(l.reason)}</Tag> },
        { title: '变动', render: (l) => <span className={l.delta > 0 ? 'text-green-600' : 'text-red-600'}>{l.delta > 0 ? `+${l.delta}` : l.delta}</span> },
        { title: '余额', render: (l) => l.balanceAfter },
        { title: '备注', render: (l) => l.note || '—', wrap: true },
      ]}
    />
  );
}
