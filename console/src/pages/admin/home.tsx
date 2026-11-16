import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api/client';
import type { AdminStats } from '../../api/types';
import { Card, Empty, ErrorText, Stat } from '../../ui';
import { OrgFilter, qs } from './common';

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

type Day = AdminStats['daily'][number];

/** 服务端只返回有记录的日期（UTC）；补齐窗口内每一天，零评分日也占一根柱子 */
export function fillDays(rows: Day[], days: number, now = Date.now()): Day[] {
  const byDay = new Map(rows.map((d) => [d.day, d]));
  const out: Day[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 86400_000).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, done: 0, failed: 0, users: 0 });
  }
  return out;
}

export function AdminHomePage() {
  const [orgId, setOrgId] = useState('');
  const stats = useQuery({ queryKey: ['admin-stats', orgId], queryFn: () => api<AdminStats>('GET', `/api/admin/stats?${qs({ orgId })}`) });
  const s = stats.data;
  const confirmRate = s && s.records ? Math.round((s.confirmed / s.records) * 100) : 0;
  const daily = s ? fillDays(s.daily, 14) : [];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">概览</h1>
        <OrgFilter value={orgId} onChange={setOrgId} />
      </div>
      <ErrorText error={stats.error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="用户数" value={s ? String(s.users) : '…'} />
        <Stat label="阅卷任务" value={s ? String(s.tasks) : '…'} />
        <Stat label="成功评分" value={s ? String(s.records) : '…'} hint={s ? `失败 ${s.failed}` : undefined} />
        <Stat label="老师确认率" value={s ? `${confirmRate}%` : '…'} hint={s ? `${s.confirmed} 份已确认` : undefined} />
        <Stat label="平均耗时" value={s ? `${(s.avgLatencyMs / 1000).toFixed(1)}s` : '…'} />
        <Stat label="平均置信度" value={s ? `${Math.round(s.avgConfidence * 100)}%` : '…'} />
        <Stat label="AI 与终分平均偏差" value={s ? num(s.avgDrift) : '…'} hint="越小说明 AI 越准" />
        <Stat label="未用额度" value={s ? String(s.creditsOutstanding) : '…'} hint="所有用户余额合计" />
      </div>
      <Card title="近 14 天评分量">
        {s && s.daily.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={daily}>
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} width={30} />
              <Tooltip />
              <Bar dataKey="done" name="成功" fill="#2563eb" stackId="a" />
              <Bar dataKey="failed" name="失败" fill="#f87171" stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <Empty text={stats.isLoading ? '加载中…' : '还没有评分记录'} />
        )}
        <p className="mt-2 text-xs text-slate-500">蓝色为成功，红色为失败（失败不扣次数）。</p>
      </Card>
    </div>
  );
}
