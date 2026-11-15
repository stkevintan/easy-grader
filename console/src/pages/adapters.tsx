import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import type { AdapterPreset } from '../api/types';
import { Button, Card, Empty, ErrorText } from '../ui';

export function AdaptersPage() {
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: ['adapters'], queryFn: () => api<AdapterPreset[]>('GET', '/api/adapters/mine') });
  const remove = useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/adapters/mine/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['adapters'] }),
  });
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">我的适配</h1>
      <p className="text-sm text-slate-500">私有适配预设在扩展的向导里创建，这里可以查看和删除。公共预设由系统管理员维护。</p>
      <ErrorText error={presets.error} />
      <ErrorText error={remove.error} />
      {presets.data && presets.data.length === 0 && <Empty text="还没有私有适配" />}
      {presets.data?.map((p) => (
        <PresetCard key={p.id} preset={p} onDelete={() => confirm('删除这个适配预设？') && remove.mutate(p.id)} />
      ))}
    </div>
  );
}

function PresetCard({ preset, onDelete }: { preset: AdapterPreset; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <div className="font-medium">{preset.name}</div>
          <div className="text-xs text-slate-500">{preset.hostPattern}{preset.pathPattern ? ` · ${preset.pathPattern}` : ''}</div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setOpen((v) => !v)}>{open ? '收起' : '查看配置'}</Button>
          <Button variant="danger" onClick={onDelete}>删除</Button>
        </div>
      </div>
      {open && (
        <pre className="mt-3 overflow-auto rounded bg-slate-50 p-3 text-xs dark:bg-slate-800">
          {JSON.stringify(preset.config, null, 2)}
        </pre>
      )}
    </Card>
  );
}
