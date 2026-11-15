import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { Page, RecordDetail, RecordItem } from '../api/types';
import { Card, Empty, Pager } from '../ui';

export function RecordsPage() {
  const [params] = useSearchParams();
  const taskId = params.get('taskId');
  const [page, setPage] = useState(1);
  const query = taskId ? `taskId=${taskId}&` : '';
  const records = useQuery({
    queryKey: ['records', page, taskId],
    queryFn: () => api<Page<RecordItem>>('GET', `/api/records?${query}page=${page}&pageSize=20`),
  });
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">评分记录{taskId ? `（任务 ${taskId}）` : ''}</h1>
      {records.data && records.data.items.length === 0 && <Empty text="没有评分记录" />}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        {records.data && records.data.items.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800">
              <tr>
                {['时间', '状态', 'AI 分', '最终分', '置信度', '自动提交', ''].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {records.data.items.map((r) => (
                <tr key={r.gradingId}>
                  <td className="px-3 py-2">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">{r.status === 'done' ? '成功' : '失败'}</td>
                  <td className="px-3 py-2">{r.status === 'done' ? `${r.score} / ${r.maxScore}` : '—'}</td>
                  <td className="px-3 py-2">{r.modifiedScore ?? '未确认'}</td>
                  <td className="px-3 py-2">{r.status === 'done' ? `${Math.round(r.confidence * 100)}%` : '—'}</td>
                  <td className="px-3 py-2">{r.isAuto ? '是' : '否'}</td>
                  <td className="px-3 py-2"><Link className="text-brand" to={`/records/${r.gradingId}`}>详情</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {records.data && <Pager page={records.data.page} pageSize={records.data.pageSize} total={records.data.total} onPage={setPage} />}
    </div>
  );
}

export function RecordDetailPage() {
  const { gradingId = '' } = useParams();
  const detail = useQuery({
    queryKey: ['record', gradingId],
    queryFn: () => api<RecordDetail>('GET', `/api/records/${gradingId}`),
  });
  const r = detail.data;
  if (detail.isLoading) return <p className="text-sm text-slate-500">加载中…</p>;
  if (!r) return <Empty text={detail.error instanceof Error ? detail.error.message : '加载失败'} />;
  const drift = r.modifiedScore != null && r.status === 'done' ? Math.abs(r.modifiedScore - r.score) : null;
  return (
    <div className="flex flex-col gap-3">
      <Link className="text-sm text-brand" to="/records">返回列表</Link>
      <Card title={r.task ? `${r.task.examTitle} · 第 ${r.task.questionNo} 题` : '评分记录'}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
          <Item label="状态" value={r.status === 'done' ? '成功' : `失败：${r.error}`} />
          <Item label="AI 分" value={r.status === 'done' ? `${r.score} / ${r.maxScore}` : '—'} />
          <Item label="最终分" value={r.modifiedScore != null ? String(r.modifiedScore) : '未确认'} />
          <Item label="偏差" value={drift != null ? drift.toFixed(2) : '—'} />
          <Item label="置信度" value={r.status === 'done' ? `${Math.round(r.confidence * 100)}%` : '—'} />
          <Item label="自动提交" value={r.isAuto ? '是' : '否'} />
          <Item label="模型" value={`${r.model || '—'}（${r.modelProfile}）`} />
          <Item label="耗时" value={`${r.latencyMs} ms`} />
          <Item label="时间" value={new Date(r.createdAt).toLocaleString()} />
        </dl>
      </Card>
      {r.reasons.length > 0 && (
        <Card title="评分理由">
          <ul className="list-disc pl-5 text-sm">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </Card>
      )}
      {r.comment && <Card title="评语"><p className="whitespace-pre-wrap text-sm">{r.comment}</p></Card>}
      {r.ocr && <Card title="识别文本"><p className="whitespace-pre-wrap text-sm">{r.ocr}</p></Card>}
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
