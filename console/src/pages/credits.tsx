import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import type { LedgerItem } from '../api/types';
import { Button, Card, Empty, ErrorText, Field, Input, ledgerReason } from '../ui';

export function CreditsPage() {
  const qc = useQueryClient();
  const ledger = useQuery({
    queryKey: ['ledger'],
    queryFn: () => api<{ balance: number; items: LedgerItem[] }>('GET', '/api/billing/ledger?limit=100'),
  });
  const [code, setCode] = useState('');
  const redeem = useMutation({
    mutationFn: () => api<{ balance: number }>('POST', '/api/billing/redeem', { code }),
    onSuccess: () => {
      setCode('');
      qc.invalidateQueries({ queryKey: ['ledger'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">额度</h1>
      <Card title={`剩余 ${ledger.data?.balance ?? '…'} 次`}>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            redeem.mutate();
          }}
        >
          <Field label="兑换码">
            <Input value={code} onChange={(e) => setCode(e.target.value)} required maxLength={40} placeholder="EG-XXXX-XXXX" />
          </Field>
          <Button variant="primary" type="submit" disabled={redeem.isPending}>兑换</Button>
        </form>
        <div className="mt-2"><ErrorText error={redeem.error} /></div>
        {redeem.isSuccess && <p className="mt-2 text-sm text-green-600">兑换成功，余额 {redeem.data.balance}</p>}
      </Card>
      <Card title="流水">
        {ledger.data && ledger.data.items.length === 0 && <Empty text="还没有流水" />}
        {ledger.data && ledger.data.items.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>{['时间', '原因', '变动', '余额', '备注'].map((h) => <th key={h} className="py-1 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {ledger.data.items.map((l) => (
                <tr key={l.id}>
                  <td className="py-1.5">{new Date(l.createdAt).toLocaleString()}</td>
                  <td>{ledgerReason(l.reason)}</td>
                  <td className={l.delta < 0 ? 'text-red-600' : 'text-green-600'}>{l.delta > 0 ? `+${l.delta}` : l.delta}</td>
                  <td>{l.balanceAfter}</td>
                  <td className="text-slate-500">{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
