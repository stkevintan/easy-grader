import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { FlagDef, FlagOverride, Page } from '../../api/types';
import { Confirm, Dialog, type DialogField } from '../../dialog';
import { Button, Card, Empty, ErrorText } from '../../ui';
import { LinkBtn, Table, Tag, fmtTime, qs } from './common';

const SCOPE_LABEL: Record<string, string> = { global: '全局', rollout: '按比例', org: '组织', user: '用户' };
const fmtFlag = (v: unknown) => (typeof v === 'boolean' ? (v ? '开' : '关') : v === '' ? '（空）' : String(v));
type Snap = { value: unknown; percent?: number | null } | null;
const fmtSnap = (s: Snap) => (s ? `${fmtFlag(s.value)}${s.percent !== null && s.percent !== undefined ? `（${s.percent}%）` : ''}` : '无');

interface AuditItem {
  id: number;
  createdAt: string;
  actorName: string;
  flagKey: string;
  scope: string;
  targetId: number;
  before: Snap;
  after: Snap;
}

interface OrgOption {
  id: number;
  name: string;
}

type Modal =
  | { kind: 'edit'; flag: FlagDef; override: FlagOverride | null; orgs: OrgOption[] }
  | { kind: 'delete'; flag: FlagDef; override: FlagOverride };

export function AdminFlagsPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<Modal | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const flags = useQuery({
    queryKey: ['admin-flags'],
    queryFn: () => api<{ modelProfiles: string[]; flags: FlagDef[] }>('GET', '/api/admin/flags'),
  });
  const audit = useQuery({
    queryKey: ['admin-flags-audit'],
    queryFn: () => api<Page<AuditItem>>('GET', '/api/admin/flags-audit?pageSize=30'),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-flags'] });
    qc.invalidateQueries({ queryKey: ['admin-flags-audit'] });
  };
  const openEdit = async (flag: FlagDef, override: FlagOverride | null) => {
    setError(null);
    try {
      const orgs = override ? [] : await api<OrgOption[]>('GET', '/api/admin/orgs');
      setModal({ kind: 'edit', flag, override, orgs });
    } catch (e) {
      setError(e);
    }
  };
  const close = () => setModal(null);
  const profiles = flags.data?.modelProfiles ?? ['default'];

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">功能开关</h1>
      <p className="text-sm text-slate-500">
        取值优先级：用户 &gt; 组织 &gt; 按比例 &gt; 全局 &gt; 默认值。停用的组织，它的覆盖不再生效。开关在代码里定义，这里只能改取值。
      </p>
      {notice && <p className="text-sm text-green-600">{notice}</p>}
      <ErrorText error={error} />
      <ErrorText error={flags.error} />
      {flags.isLoading && <Empty text="加载中…" />}
      {flags.data?.flags.map((f) => (
        <div key={f.key} data-flag={f.key}>
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <b>{f.key}</b>
              <Tag>{f.type}</Tag>
              <Tag>{f.client ? '下发扩展' : '仅服务端'}</Tag>
              <span className="flex-1" />
              <Button onClick={() => openEdit(f, null)}>新增覆盖</Button>
            </div>
            <p className="mt-2 text-sm">{f.description}</p>
            <p className="mt-1 text-xs text-slate-500">
              默认值：{fmtFlag(f.default)} · 负责人：{f.owner} · 计划删除：{f.removeBy === 'permanent' ? '长期保留' : f.removeBy}
            </p>
            <div className="mt-3">
              {f.overrides.length ? (
                <Table
                  rows={f.overrides}
                  rowKey={(o) => `${o.scope}-${o.targetId}`}
                  cols={[
                    { title: '范围', render: (o) => SCOPE_LABEL[o.scope] },
                    { title: '对象', render: (o) => (o.scope === 'rollout' ? `${o.percent}% 的用户` : o.targetName || '所有人') },
                    { title: '取值', render: (o) => <span>{fmtFlag(o.value)} {!o.valid && <Tag kind="bad">已失效</Tag>}</span> },
                    { title: '更新时间', render: (o) => fmtTime(o.updatedAt) },
                    {
                      title: '操作',
                      render: (o) => (
                        <div className="flex gap-3">
                          <LinkBtn onClick={() => openEdit(f, o)}>修改</LinkBtn>
                          <LinkBtn danger onClick={() => setModal({ kind: 'delete', flag: f, override: o })}>删除</LinkBtn>
                        </div>
                      ),
                    },
                  ]}
                />
              ) : (
                <p className="text-sm text-slate-500">没有覆盖，所有人使用默认值</p>
              )}
            </div>
          </Card>
        </div>
      ))}
      <h2 className="mt-2 text-base font-semibold">最近修改</h2>
      <ErrorText error={audit.error} />
      {audit.data && (
        <Table
          rows={audit.data.items}
          rowKey={(x) => x.id}
          empty="还没有修改记录"
          cols={[
            { title: '时间', render: (x) => fmtTime(x.createdAt) },
            { title: '操作人', render: (x) => x.actorName },
            { title: '开关', render: (x) => x.flagKey },
            { title: '范围', render: (x) => `${SCOPE_LABEL[x.scope] ?? x.scope}${x.targetId ? ` #${x.targetId}` : ''}` },
            { title: '修改前', render: (x) => fmtSnap(x.before) },
            { title: '修改后', render: (x) => fmtSnap(x.after) },
          ]}
        />
      )}
      {modal?.kind === 'edit' && (
        <FlagDialog
          flag={modal.flag}
          override={modal.override}
          orgs={modal.orgs}
          profiles={profiles}
          onSaved={() => {
            setNotice('已保存，扩展最晚 5 分钟内生效');
            refresh();
          }}
          onClose={close}
        />
      )}
      {modal?.kind === 'delete' && (
        <Confirm
          title="删除覆盖"
          text={`删除后这部分用户回到下一级的取值。确定删除 ${modal.flag.key} 的「${SCOPE_LABEL[modal.override.scope]}${modal.override.targetName ? ` ${modal.override.targetName}` : ''}」覆盖？`}
          onOk={async () => {
            await api('DELETE', `/api/admin/flags/${modal.flag.key}?${qs({ scope: modal.override.scope, targetId: modal.override.targetId || '' })}`);
            setNotice('已删除');
            refresh();
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

function FlagDialog({
  flag,
  override: o,
  orgs,
  profiles,
  onSaved,
  onClose,
}: {
  flag: FlagDef;
  override: FlagOverride | null;
  orgs: OrgOption[];
  profiles: string[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const valueField: DialogField =
    flag.type === 'boolean'
      ? { name: 'value', label: '取值', type: 'select', options: [['true', '开'], ['false', '关']], value: String(o ? o.value : !flag.default) }
      : flag.key === 'model_profile'
        ? { name: 'value', label: '取值', type: 'select', options: profiles.map((p) => [p, p]), value: String(o ? o.value : flag.default) }
        : {
            name: 'value',
            label: '取值',
            type: flag.type === 'number' ? 'number' : 'text',
            step: 'any',
            value: String(o ? o.value : flag.default),
            placeholder: flag.key === 'min_extension_version' ? '如 0.2.0，留空表示不限制' : '',
          };
  const fields: DialogField[] = o
    ? [valueField]
    : [
        { name: 'scope', label: '范围', type: 'select', options: [['org', '某个组织'], ['user', '某个用户'], ['rollout', '按比例放量'], ['global', '全局（替代默认值）']] },
        { name: 'orgId', label: '组织（范围为组织时）', type: 'select', options: orgs.length ? orgs.map((u) => [String(u.id), u.name]) : [['', '（还没有组织）']] },
        { name: 'username', label: '用户名（范围为用户时）', placeholder: '准确的用户名' },
        valueField,
      ];
  if (!o || o.scope === 'rollout') {
    fields.push({
      name: 'percent',
      label: '放量比例 %（范围为按比例时）',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
      value: o?.percent ?? 10,
      hint: '按用户 id 稳定分桶：调大比例时，已经拿到新值的用户不会变回去',
    });
  }
  return (
    <Dialog
      title={o ? `修改 ${flag.key}：${SCOPE_LABEL[o.scope]}${o.targetName ? ` ${o.targetName}` : ''}` : `新增覆盖：${flag.key}`}
      fields={fields}
      submitText="保存"
      onSubmit={async (v) => {
        const scope = o ? o.scope : String(v.scope);
        let targetId = o ? o.targetId : undefined;
        if (!o && scope === 'org') {
          if (!v.orgId) throw new Error('请先建一个组织');
          targetId = Number(v.orgId);
        }
        let username: string | undefined;
        if (!o && scope === 'user') {
          username = String(v.username).trim();
          if (!username) throw new Error('请输入用户名');
        }
        const raw = String(v.value);
        const value = flag.type === 'boolean' ? raw === 'true' : flag.type === 'number' ? Number(raw) : raw.trim();
        if (flag.type === 'number' && (raw === '' || !Number.isFinite(value))) throw new Error('请输入数字');
        const body = {
          scope,
          value,
          ...(targetId ? { targetId } : {}),
          ...(username ? { username } : {}),
          ...(scope === 'rollout' ? { percent: Number(v.percent) } : {}),
        };
        await api('PUT', `/api/admin/flags/${flag.key}`, body);
        onSaved();
      }}
      onClose={onClose}
    />
  );
}
