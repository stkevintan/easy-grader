import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { AdminModelInfo, AdminModelProfile } from '../../api/types';
import { Dialog, type DialogField } from '../../dialog';
import { Button, Card, Empty, ErrorText } from '../../ui';
import { LinkBtn, Table, Tag, fmtNum, type Column } from './common';

const EFFORT_OPTIONS: [string, string][] = [
  ['', '不传（用服务商默认）'],
  ['none', 'none'],
  ['minimal', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
];

const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—');

/** 编辑/新增一个方案的字段；新增时第一项是方案名 */
function fieldsFor(p: AdminModelProfile | null): DialogField[] {
  const base: DialogField[] = p
    ? []
    : [
        {
          name: 'name',
          label: '方案名（功能开关 model_profile 里选它）',
          required: true,
          maxLength: 40,
          hint: '字母、数字、下划线、点、短横线；default 是默认模型，不用新建',
        },
      ];
  return [
    ...base,
    { name: 'model', label: '模型名', value: p?.model ?? '', required: true, maxLength: 100, placeholder: 'qwen-vl-max' },
    { name: 'baseUrl', label: '接口地址', value: p?.baseUrl ?? '', required: true, maxLength: 300, placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    {
      name: 'apiKey',
      label: 'API Key',
      type: 'password',
      value: '',
      maxLength: 400,
      placeholder: p?.apiKeyConfigured ? '已配置，留空保持原值' : '还没有配置',
      hint: '只写不读；留空表示不改，填 - 可以清掉、退回环境变量',
    },
    { name: 'sampleCount', label: '并行采样次数（1–5）', type: 'number', value: p?.params.sampleCount ?? 1, min: 1, max: 5 },
    { name: 'maxTokens', label: '单次最大输出 token', type: 'number', value: p?.params.maxTokens ?? 8000, min: 256, max: 200000 },
    { name: 'reasoningEffort', label: '思考强度', type: 'select', value: p?.params.reasoningEffort ?? '', options: EFFORT_OPTIONS },
    { name: 'temperature', label: '温度（0–2）', type: 'number', value: p?.params.temperature ?? 0.1, min: 0, max: 2, step: 0.1 },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number', value: p?.params.timeoutMs ?? 60000, min: 1000, max: 600000 },
    { name: 'scoreWithImage', label: '打分阶段把答卷图片一起发给模型', type: 'checkbox', value: p?.params.scoreWithImage ?? true },
  ];
}

type Modal =
  | { kind: 'edit'; profile: AdminModelProfile | null }
  | { kind: 'delete'; profile: AdminModelProfile };

export function AdminModelPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<Modal | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [testing, setTesting] = useState('');

  const q = useQuery({
    queryKey: ['admin-model'],
    queryFn: () => api<AdminModelInfo>('GET', '/api/admin/model'),
  });
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-model'] });

  const submit = async (values: Record<string, string | boolean>) => {
    if (!modal || modal.kind !== 'edit') return false;
    const p = modal.profile;
    const name = p?.name ?? String(values.name ?? '').trim();
    if (!name) throw new Error('方案名不能为空');
    const body: Record<string, string | number | boolean> = {
      model: String(values.model).trim(),
      baseUrl: String(values.baseUrl).trim(),
      sampleCount: Number(values.sampleCount),
      maxTokens: Number(values.maxTokens),
      reasoningEffort: String(values.reasoningEffort),
      temperature: Number(values.temperature),
      timeoutMs: Number(values.timeoutMs),
      scoreWithImage: Boolean(values.scoreWithImage),
    };
    const key = String(values.apiKey ?? '').trim();
    if (key === '-') body.apiKey = '';
    else if (key) body.apiKey = key;
    setError(null);
    setNotice('');
    try {
      await api('PUT', `/api/admin/model/${encodeURIComponent(name)}`, body);
      await refresh();
      setNotice(p ? `已保存「${name}」，探测通过，立刻生效` : `已新增「${name}」，探测通过，立刻生效`);
      setModal(null);
    } catch (e) {
      throw e;
    }
  };

  const test = async (p: AdminModelProfile) => {
    setError(null);
    setNotice('');
    setTesting(p.name);
    try {
      const r = await api<AdminModelProfile>('POST', `/api/admin/model/${encodeURIComponent(p.name)}/test`);
      await refresh();
      setNotice(r.vision.ok ? `「${p.name}」读图正常（${fmtTime(r.vision.checkedAt)}）` : `「${p.name}」读不了图：${r.vision.error}`);
    } catch (e) {
      setError(e);
    } finally {
      setTesting('');
    }
  };

  const remove = async (p: AdminModelProfile) => {
    await api('DELETE', `/api/admin/model/${encodeURIComponent(p.name)}`);
    await refresh();
  };

  const reset = async (p: AdminModelProfile) => {
    await api('POST', `/api/admin/model/${encodeURIComponent(p.name)}/reset`);
    await refresh();
    setNotice(`「${p.name}」已恢复为环境变量`);
  };

  const cols: Column<AdminModelProfile>[] = [
    {
      title: '方案',
      render: (p) => (
        <div className="flex flex-col">
          <span className="font-mono text-xs">{p.name}</span>
          {p.name === 'default' && <Tag kind="brand">默认</Tag>}
        </div>
      ),
    },
    { title: '模型', render: (p) => <span className="font-mono text-xs">{p.model || '(未设置)'}</span> },
    {
      title: '视觉',
      render: (p) =>
        p.vision.ok ? (
          <Tag kind="ok">可读图</Tag>
        ) : (
          <span title={p.vision.error}>
            <Tag kind="bad">未通过</Tag>
          </span>
        ),
    },
    {
      title: '参数',
      render: (p) => (
        <span className="text-xs text-slate-500">
          采样 {p.params.sampleCount} · token {p.params.maxTokens} · {p.params.reasoningEffort || '默认强度'}
        </span>
      ),
    },
    { title: '更新时间', render: (p) => <span className="text-xs">{fmtTime(p.updated.at)}</span> },
    {
      title: '操作',
      render: (p) => (
        <div className="flex flex-wrap gap-2">
          <LinkBtn onClick={() => setModal({ kind: 'edit', profile: p })}>编辑</LinkBtn>
          <LinkBtn onClick={() => test(p)}>{testing === p.name ? '探测中…' : '测试读图'}</LinkBtn>
          {p.overrides.length > 0 && <LinkBtn onClick={() => reset(p)}>恢复环境变量</LinkBtn>}
          {p.name !== 'default' && <LinkBtn danger onClick={() => setModal({ kind: 'delete', profile: p })}>删除</LinkBtn>}
        </div>
      ),
    },
  ];

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
        可以配多个方案：<code>default</code> 是默认模型，其他方案名填进功能开关 <code>model_profile</code> 就能分给部分用户。每个方案保存前都会真的发一张测试图，读不了图的模型不允许保存。密钥只写不读。
      </p>
      {d && !d.profiles.find((p) => p.name === 'default')?.ready && (
        <p className="text-sm text-amber-600">
          <Tag kind="warn">默认模型不可用</Tag> 没配 API Key（或模型名/地址缺项），评分会走 mock，分数是假的。
        </p>
      )}
      {notice && <p className="text-sm text-green-600">{notice}</p>}
      <ErrorText error={error} />
      <ErrorText error={q.error} />
      {q.isLoading && <Empty text="加载中…" />}
      {d && (
        <>
          <Card>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="font-medium">模型方案</h2>
              <span className="flex-1" />
              <Button onClick={() => setModal({ kind: 'edit', profile: null })}>新增方案</Button>
            </div>
            <Table rows={d.profiles} rowKey={(p) => p.name} cols={cols} />
            {d.profiles.some((p) => !p.vision.ok && p.vision.error) && (
              <ul className="mt-2 list-disc pl-5 text-xs text-amber-600">
                {d.profiles
                  .filter((p) => p.vision.error)
                  .map((p) => (
                    <li key={p.name}>
                      {p.name}：{p.vision.error}
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-2 font-medium">近 7 天各模型评分</h2>
            <Table rows={d.usage} rowKey={(r) => r.model} cols={usageCols} empty="近 7 天还没有评分记录" />
          </Card>

          <p className="text-xs text-slate-500">
            两阶段评分 {d.fixed.ocrTwoPass ? '开' : '关'}；单张图片上限 {(d.fixed.maxImageBytes / 1024 / 1024).toFixed(1)} MB；重试{' '}
            {d.fixed.maxRetries} 次、首次等待 {d.fixed.retryDelayMs} ms（这三项只能在环境变量里改）。
          </p>
        </>
      )}

      {modal?.kind === 'edit' && (
        <Dialog
          title={modal.profile ? `编辑「${modal.profile.name}」` : '新增模型方案'}
          fields={fieldsFor(modal.profile)}
          submitText="保存并测试读图"
          onSubmit={submit}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'delete' && (
        <Dialog
          title={`删除「${modal.profile.name}」`}
          submitText="删除"
          extra={<p className="text-sm">用到这个方案的开关覆盖会退回 default。这个操作不影响已经评过的记录。</p>}
          onSubmit={async () => {
            await remove(modal.profile);
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
