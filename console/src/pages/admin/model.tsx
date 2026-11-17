import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { AdminModelInfo } from '../../api/types';
import { Button, Card, Empty, ErrorText, Input } from '../../ui';
import { Table, Tag, fmtNum, type Column } from './common';

/** 可编辑的字段；改完保存立即生效 */
interface Form {
  name: string;
  baseUrl: string;
  apiKey: string;
  sampleCount: string;
  maxTokens: string;
  reasoningEffort: string;
  temperature: string;
  timeoutMs: string;
  scoreWithImage: boolean;
}

const toForm = (d: AdminModelInfo): Form => ({
  name: d.name,
  baseUrl: d.baseUrl,
  apiKey: '',
  sampleCount: String(d.params.sampleCount),
  maxTokens: String(d.params.maxTokens),
  reasoningEffort: d.params.reasoningEffort === '(不传)' ? '' : d.params.reasoningEffort,
  temperature: String(d.params.temperature),
  timeoutMs: String(d.params.timeoutMs),
  scoreWithImage: d.params.scoreWithImage,
});

/** 只提交改动过的字段；密钥留空表示不修改 */
function diff(d: AdminModelInfo, f: Form) {
  const init = toForm(d);
  const patch: Record<string, string | number | boolean> = {};
  if (f.name !== init.name) patch.name = f.name.trim();
  if (f.baseUrl !== init.baseUrl) patch.baseUrl = f.baseUrl.trim();
  if (f.apiKey) patch.apiKey = f.apiKey.trim();
  if (f.sampleCount !== init.sampleCount) patch.sampleCount = Number(f.sampleCount);
  if (f.maxTokens !== init.maxTokens) patch.maxTokens = Number(f.maxTokens);
  if (f.reasoningEffort !== init.reasoningEffort) patch.reasoningEffort = f.reasoningEffort;
  if (f.temperature !== init.temperature) patch.temperature = Number(f.temperature);
  if (f.timeoutMs !== init.timeoutMs) patch.timeoutMs = Number(f.timeoutMs);
  if (f.scoreWithImage !== init.scoreWithImage) patch.scoreWithImage = f.scoreWithImage;
  return patch;
}

export function AdminModelPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin-model'],
    queryFn: () => api<AdminModelInfo>('GET', '/api/admin/model'),
  });
  const d = q.data;
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (d && !form) setForm(toForm(d));
  }, [d, form]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const refresh = async () => {
    const next = await qc.fetchQuery({ queryKey: ['admin-model'], queryFn: () => api<AdminModelInfo>('GET', '/api/admin/model') });
    setForm(toForm(next));
  };

  const save = async () => {
    if (!d || !form) return;
    setError(null);
    setNotice('');
    const patch = diff(d, form);
    if (Object.keys(patch).length === 0) {
      setNotice('没有改动');
      return;
    }
    setSaving(true);
    try {
      await api('PUT', '/api/admin/model', patch);
      await refresh();
      setNotice('已保存，下一次评分就用新配置，不需要重新部署');
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setError(null);
    setNotice('');
    setSaving(true);
    try {
      await api('DELETE', '/api/admin/model');
      await refresh();
      setNotice('已恢复为环境变量里的配置');
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const usageCols: Column<AdminModelInfo['usage'][number]>[] = [
    { title: '模型', render: (r) => <span className="font-mono text-xs">{r.model}</span> },
    { title: '评分次数', render: (r) => r.total },
    { title: '成功', render: (r) => r.done },
    { title: '失败', render: (r) => (r.failed ? <Tag kind="bad">{r.failed}</Tag> : 0) },
    { title: '平均延迟', render: (r) => (r.avgLatencyMs ? `${fmtNum(r.avgLatencyMs, 0)} ms` : '—') },
  ];

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">模型</h1>
      <p className="text-sm text-slate-500">
        这里改的值会存进数据库并立刻生效，优先于容器环境变量；点「恢复为环境变量」可以全部退回去。密钥只能写入，不会显示出来。
      </p>
      <ErrorText error={q.error} />
      <ErrorText error={error} />
      {notice && <p className="text-sm text-green-600">{notice}</p>}
      {q.isLoading && <Empty text="加载中…" />}
      {d && form && (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <b className="font-mono">{d.name || '(未设置 MODEL_NAME)'}</b>
              {d.ready ? <Tag kind="ok">已就绪</Tag> : <Tag kind="bad">不可用</Tag>}
              {!d.apiKeyConfigured && <Tag kind="warn">没配 API Key，评分走 mock，分数是假的</Tag>}
              {d.overrides.length > 0 && <Tag kind="brand">{d.overrides.length} 项来自控制台</Tag>}
            </div>
            {d.updated.at && (
              <div className="mt-1 text-xs text-slate-500">
                最后修改：{new Date(d.updated.at).toLocaleString('zh-CN', { hour12: false })}
                {d.updated.byName ? `（${d.updated.byName}）` : ''}
              </div>
            )}
          </Card>

          <Card>
            <h2 className="mb-2 font-medium">模型配置</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">模型名（MODEL_NAME）</span>
                <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="qwen-vl-max" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">接口地址（MODEL_BASE_URL）</span>
                <Input value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.deepseek.com" />
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span className="text-slate-500">API Key（留空表示不修改）</span>
                <Input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => set('apiKey', e.target.value)}
                  placeholder={d.apiKeyConfigured ? '已配置，留空保持原值' : '还没有配置，评分会用 mock'}
                  autoComplete="new-password"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">思考强度</span>
                <select
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
                  value={form.reasoningEffort}
                  onChange={(e) => set('reasoningEffort', e.target.value)}
                >
                  <option value="">不传（用服务商默认）</option>
                  <option value="none">none</option>
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">并行采样次数（取中位数）</span>
                <Input value={form.sampleCount} onChange={(e) => set('sampleCount', e.target.value)} inputMode="numeric" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">单次最大输出 token</span>
                <Input value={form.maxTokens} onChange={(e) => set('maxTokens', e.target.value)} inputMode="numeric" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">温度</span>
                <Input value={form.temperature} onChange={(e) => set('temperature', e.target.value)} inputMode="decimal" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">超时（毫秒）</span>
                <Input value={form.timeoutMs} onChange={(e) => set('timeoutMs', e.target.value)} inputMode="numeric" />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.scoreWithImage}
                  onChange={(e) => set('scoreWithImage', e.target.checked)}
                />
                <span>打分阶段把答卷图片一起发给模型（关掉只用转录文字）</span>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={save} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
              <Button onClick={reset} disabled={saving || d.overrides.length === 0}>
                恢复为环境变量
              </Button>
              <span className="text-xs text-slate-500">
                两阶段评分：{d.params.ocrTwoPass ? '开' : '关'}；单张图片上限 {(d.params.maxImageBytes / 1024 / 1024).toFixed(1)} MB；重试{' '}
                {d.params.maxRetries} 次（这三项只能在环境变量里改）
              </span>
            </div>
          </Card>

          <Card>
            <h2 className="mb-2 font-medium">模型方案</h2>
            {d.profiles.length === 0 ? (
              <p className="text-sm text-slate-500">
                没有配置 MODEL_PROFILES，所有用户都走上面的默认模型。功能开关 <code>model_profile</code> 用来把用户分到不同方案。
              </p>
            ) : (
              <Table
                rows={d.profiles}
                rowKey={(p) => p.name}
                cols={[
                  { title: '方案', render: (p) => <span className="font-mono text-xs">{p.name}</span> },
                  { title: '覆盖的字段', render: (p) => (p.overrides.length ? p.overrides.join('、') : '无') },
                ]}
              />
            )}
          </Card>

          <Card>
            <h2 className="mb-2 font-medium">近 7 天各模型评分</h2>
            <Table rows={d.usage} rowKey={(r) => r.model} cols={usageCols} empty="近 7 天还没有评分记录" />
          </Card>
        </>
      )}
    </div>
  );
}
