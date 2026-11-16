import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function cn(...parts: (string | false | undefined)[]) {
  return clsx(parts);
}

export function Button({
  variant = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  return (
    <button
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50',
        variant === 'primary' && 'bg-brand text-white hover:bg-blue-700',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        variant === 'default' && 'border border-slate-300 bg-white hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700',
        variant === 'ghost' && 'hover:bg-slate-100 dark:hover:bg-slate-800',
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-600 dark:text-slate-300">{label}</span>
      {children}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand dark:border-slate-600 dark:bg-slate-800"
      {...props}
    />
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand dark:border-slate-600 dark:bg-slate-800"
      rows={4}
      {...props}
    />
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-sm text-red-600">{error instanceof Error ? error.message : '出错了'}</p>;
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      {title && <h2 className="mb-3 text-base font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-slate-500">{text}</p>;
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-sm">
      <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</Button>
      <span className="text-slate-500">{page} / {pages}</span>
      <Button disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</Button>
    </div>
  );
}

const LEDGER_REASONS: Record<string, string> = {
  register: '注册赠送',
  redeem: '兑换码',
  judge: '评分',
  refund: '退还',
  admin: '管理员调整',
};
export const ledgerReason = (r: string) => LEDGER_REASONS[r] ?? r;
