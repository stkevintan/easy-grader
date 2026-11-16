import { useEffect, useState, type ReactNode } from 'react';
import { Empty, ErrorText, Input, Pager, cn } from '../../ui';

export const qs = (o: Record<string, string | number | undefined | null>) =>
  new URLSearchParams(
    Object.entries(o)
      .filter(([, v]) => v !== '' && v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  ).toString();

/** 服务端 SQLite 时间没有时区后缀时按 UTC 解析 */
export function fmtTime(s: string | null | undefined) {
  if (!s) return '—';
  const str = String(s);
  const iso = str.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? '' : 'Z');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? str : d.toLocaleString('zh-CN', { hour12: false });
}

export const fmtNum = (n: number | null | undefined, d = 1) =>
  n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : Number(n).toFixed(d);

export function Tag({ kind, children }: { kind?: 'ok' | 'bad' | 'warn' | 'brand'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'mx-0.5 inline-block rounded px-1.5 py-0.5 text-xs',
        kind === 'ok' && 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
        kind === 'bad' && 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
        kind === 'warn' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
        kind === 'brand' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
        !kind && 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
      )}
    >
      {children}
    </span>
  );
}

export function LinkBtn({ danger, onClick, children }: { danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn('text-sm hover:underline', danger ? 'text-red-600' : 'text-brand')}>
      {children}
    </button>
  );
}

export interface Column<T> {
  title: string;
  render: (row: T) => ReactNode;
  wrap?: boolean;
}

export function Table<T>({ cols, rows, rowKey, empty = '暂无数据' }: { cols: Column<T>[]; rows: T[]; rowKey: (r: T) => string | number; empty?: string }) {
  if (!rows.length) return <Empty text={empty} />;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800">
          <tr>{cols.map((c) => <th key={c.title} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{c.title}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {cols.map((c) => (
                <td key={c.title} className={cn('px-3 py-2 align-top', c.wrap ? 'max-w-xs break-words' : 'whitespace-nowrap')}>
                  {c.render(r) ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 搜索框：输入停顿 300ms 后才更新 */
export function SearchBox({ placeholder, onChange }: { placeholder: string; onChange: (q: string) => void }) {
  const [v, setV] = useState('');
  useEffect(() => {
    const t = setTimeout(() => onChange(v.trim()), 300);
    return () => clearTimeout(t);
  }, [v, onChange]);
  return (
    <div className="w-64">
      <Input type="search" placeholder={placeholder} aria-label={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
    </div>
  );
}

/** 列表页的外框：标题、工具栏、加载/错误、表格、分页 */
export function ListPage<T>({
  title,
  toolbar,
  search,
  query,
  cols,
  rowKey,
  empty,
  page,
  onPage,
}: {
  title: string;
  toolbar?: ReactNode;
  search?: ReactNode;
  query: { data?: T[] | { items: T[]; total: number; page: number; pageSize: number }; isLoading: boolean; error: unknown };
  cols: Column<T>[];
  rowKey: (r: T) => string | number;
  empty?: string;
  page?: number;
  onPage?: (p: number) => void;
}) {
  const d = query.data;
  const rows = d ? (Array.isArray(d) ? d : d.items) : [];
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {search}
        <span className="flex-1" />
        {toolbar}
      </div>
      <ErrorText error={query.error} />
      {query.isLoading ? <Empty text="加载中…" /> : !query.error && <Table cols={cols} rows={rows} rowKey={rowKey} empty={empty} />}
      {d && !Array.isArray(d) && onPage && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>共 {d.total} 条</span>
          <Pager page={page ?? d.page} pageSize={d.pageSize} total={d.total} onPage={onPage} />
        </div>
      )}
      {Array.isArray(d) && <span className="text-sm text-slate-500">共 {d.length} 条</span>}
    </div>
  );
}

/**
 * 生成结果的展示：只读文本框加复制按钮。
 * lines 是展示的内容；copy 是「复制全部」复制的内容，默认同 lines。
 */
export function CopyList({ label, lines, copy = lines }: { label: string; lines: string[]; copy?: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="f-codes" className="text-sm text-slate-600 dark:text-slate-300">{label}</label>
      <textarea id="f-codes" readOnly value={lines.join('\n')} rows={Math.min(12, Math.max(3, lines.length))} className="w-full rounded-md border border-slate-300 px-3 py-1.5 font-mono text-sm dark:border-slate-600 dark:bg-slate-800" />
      <button
        type="button"
        className="self-start text-sm text-brand hover:underline"
        onClick={() => navigator.clipboard.writeText(copy.join('\n')).then(() => setCopied(true))}
      >
        {copied ? '已复制' : '复制全部'}
      </button>
    </div>
  );
}
