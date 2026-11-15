import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { api } from '../../api/client';
import type { AdminPreset } from '../../api/types';
import { Confirm, Dialog } from '../../dialog';
import { Button, ErrorText } from '../../ui';
import { LinkBtn, ListPage, SearchBox, Tag, fmtTime, qs } from './common';

const EXAMPLE_CONFIG = {
  version: 1,
  pics: { selectors: ['#answer img'], type: 'img', multiple: false },
  scoreMode: 'input',
  scoreInput: { selectors: ['input.score'] },
  scoreButtons: { selectors: [], clickType: 'click' },
  submit: { selectors: ['button.submit'], clickType: 'click' },
  confirm: { selectors: [] },
  examTitle: { selectors: ['.exam-name'] },
  questionNo: { selectors: ['.question-no'] },
  nextTimeoutMs: 8000,
  submitDelayMs: 300,
};

type Modal =
  | { kind: 'edit'; preset: AdminPreset | null }
  | { kind: 'public'; preset: AdminPreset }
  | { kind: 'delete'; preset: AdminPreset };

export function AdminPresetsPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [modal, setModal] = useState<Modal | null>(null);
  const [error, setError] = useState<unknown>(null);
  const presets = useQuery({
    queryKey: ['admin-presets', q],
    queryFn: () => api<AdminPreset[]>('GET', `/api/admin/presets?${qs({ q })}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-presets'] });
  const onSearch = useCallback((v: string) => setQ(v), []);
  const close = () => setModal(null);
  const toggle = async (p: AdminPreset) => {
    setError(null);
    try {
      await api('PATCH', `/api/admin/presets/${p.id}`, { enabled: !p.enabled });
      refresh();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <ErrorText error={error} />
      <ListPage
        title="适配预设"
        search={<SearchBox placeholder="搜索名称或域名" onChange={onSearch} />}
        toolbar={
          <>
            <span className="text-xs text-slate-500">老师自己点选生成的是私有预设；验证可用后可改为公共，供所有人使用。</span>
            <Button variant="primary" onClick={() => setModal({ kind: 'edit', preset: null })}>新建预设</Button>
          </>
        }
        query={presets}
        rowKey={(p) => p.id}
        empty="还没有预设。老师在扩展里点选适配后，会出现在这里。"
        cols={[
          { title: 'ID', render: (p) => p.id },
          { title: '名称', render: (p) => p.name, wrap: true },
          { title: '匹配', render: (p) => <code>{p.hostPattern + (p.pathPattern ? ` · ${p.pathPattern}` : '')}</code> },
          { title: '给分方式', render: (p) => (p.config.scoreMode === 'buttons' ? '打分板' : '输入框') },
          { title: '答卷', render: (p) => `${p.config.pics?.type ?? '—'}${p.config.pics?.multiple ? ' ×多' : ''}` },
          { title: '范围', render: (p) => (p.scope === 'public' ? <Tag kind="brand">公共</Tag> : <Tag>私有 · 用户 #{p.ownerId}</Tag>) },
          { title: '状态', render: (p) => (p.enabled ? <Tag kind="ok">启用</Tag> : <Tag kind="bad">停用</Tag>) },
          { title: '更新时间', render: (p) => fmtTime(p.updatedAt) },
          {
            title: '操作',
            render: (p) => (
              <div className="flex gap-3">
                <LinkBtn onClick={() => setModal({ kind: 'edit', preset: p })}>编辑</LinkBtn>
                {p.scope === 'private' && <LinkBtn onClick={() => setModal({ kind: 'public', preset: p })}>设为公共</LinkBtn>}
                <LinkBtn onClick={() => toggle(p)}>{p.enabled ? '停用' : '启用'}</LinkBtn>
                <LinkBtn danger onClick={() => setModal({ kind: 'delete', preset: p })}>删除</LinkBtn>
              </div>
            ),
          },
        ]}
      />
      {modal?.kind === 'edit' && (
        <Dialog
          title={modal.preset ? `编辑预设：${modal.preset.name}` : '新建适配预设'}
          fields={[
            { name: 'name', label: '名称', required: true, maxLength: 100, value: modal.preset?.name },
            { name: 'hostPattern', label: '域名（会同时匹配子域名）', required: true, maxLength: 255, value: modal.preset?.hostPattern, placeholder: 'xiaoxianai.cn' },
            { name: 'pathPattern', label: '路径包含（可选）', maxLength: 200, value: modal.preset?.pathPattern, placeholder: '/mark/' },
            { name: 'scope', label: '可见范围', type: 'select', value: modal.preset?.scope ?? 'public', options: [['public', '公共：所有用户可用'], ['private', '私有：仅创建者']] },
            { name: 'enabled', label: '启用', type: 'checkbox', value: modal.preset ? modal.preset.enabled : true },
            { name: 'config', label: '选择器配置（JSON）', type: 'textarea', value: JSON.stringify(modal.preset?.config ?? EXAMPLE_CONFIG, null, 2) },
            { name: 'note', label: '备注', maxLength: 500, value: modal.preset?.note },
          ]}
          onSubmit={async (v) => {
            let config: unknown;
            try {
              config = JSON.parse(String(v.config));
            } catch {
              throw new Error('配置不是合法的 JSON');
            }
            const body = {
              name: String(v.name).trim(),
              hostPattern: String(v.hostPattern).trim(),
              pathPattern: String(v.pathPattern).trim(),
              scope: v.scope,
              enabled: v.enabled,
              config,
              note: v.note,
            };
            if (modal.preset) await api('PATCH', `/api/admin/presets/${modal.preset.id}`, body);
            else await api('POST', '/api/admin/presets', body);
            refresh();
          }}
          onClose={close}
        />
      )}
      {modal?.kind === 'public' && (
        <Confirm
          title="设为公共预设"
          text={`所有用户访问 ${modal.preset.hostPattern} 时都会用这份配置。请确认已在真实页面验证过。`}
          onOk={async () => {
            await api('PATCH', `/api/admin/presets/${modal.preset.id}`, { scope: 'public' });
            refresh();
          }}
          onClose={close}
        />
      )}
      {modal?.kind === 'delete' && (
        <Confirm
          title="删除预设"
          text={`确定删除「${modal.preset.name}」？此操作不可撤销。`}
          onOk={async () => {
            await api('DELETE', `/api/admin/presets/${modal.preset.id}`);
            refresh();
          }}
          onClose={close}
        />
      )}
    </>
  );
}
