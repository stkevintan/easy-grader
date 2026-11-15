import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api/client';
import { useMe } from '../api/auth';
import type { MyStats, Page, RecordItem } from '../api/types';
import { Card, Empty, ErrorText, Stat } from '../ui';

const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const num = (n: number | null) => (n == null ? '—' : n.toFixed(2));

export function HomePage() {
  const me = useMe();
  const stats = useQuery({ queryKey: ['me-stats'], queryFn: () => api<MyStats>('GET', '/api/me/stats?days=30') });
  const recent = useQuery({ queryKey: ['records', 1], queryFn: () => api<Page<RecordItem>>('GET', '/api/records?page=1&pageSize=5') });
  const t = stats.data?.totals;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">你好，{me.data?.username ?? '…'}</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="剩余额度" value={me.data ? String(me.data.credits) : '…'} />
        <Stat label="累计评分" value={t ? String(t.done) : '…'} />
        <Stat label="平均偏差（AI 与最终分）" value={t ? num(t.avgDrift) : '…'} />
        <Stat label="平均置信度" value={t ? pct(t.avgConfidence) : '…'} />
      </div>
      <Card title="近 30 天评分量">
        {stats.data && stats.data.daily.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stats.data.daily}>
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} width={30} />
              <Tooltip />
              <Bar dataKey="done" name="成功" fill="#2563eb" stackId="a" />
              <Bar dataKey="failed" name="失败" fill="#f87171" stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        ) : stats.error ? (
          <ErrorText error={stats.error} />
        ) : (
          <Empty text={stats.isLoading ? '加载中…' : '还没有评分记录'} />
        )}
      </Card>
      <Card title="最近的评分记录">
        {recent.data && recent.data.items.length > 0 ? (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {recent.data.items.map((r) => (
              <li key={r.gradingId} className="flex items-center justify-between py-2">
                <span>{new Date(r.createdAt).toLocaleString()} · {r.status === 'done' ? `${r.score} / ${r.maxScore}` : '失败'}</span>
                <Link className="text-brand" to={`/records/${r.gradingId}`}>详情</Link>
              </li>
            ))}
          </ul>
        ) : recent.error ? (
          <ErrorText error={recent.error} />
        ) : (
          <Empty text={recent.isLoading ? '加载中…' : '还没有评分记录'} />
        )}
      </Card>
    </div>
  );
}
