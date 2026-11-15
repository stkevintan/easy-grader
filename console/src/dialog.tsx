import { useState } from 'react';
import { Button, ErrorText, Field, Input, TextArea } from './ui';

export interface DialogField {
  name: string;
  label: string;
  type?: 'text' | 'password' | 'number' | 'date' | 'select' | 'textarea' | 'checkbox';
  value?: string | number | boolean;
  options?: [string, string][];
  required?: boolean;
  min?: number;
  max?: number;
  step?: number | string;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
  readOnly?: boolean;
}

/**
 * 表单对话框。onSubmit 返回 false 或抛错则不关闭；抛出的错误显示在表单里。
 */
export function Dialog({
  title,
  fields = [],
  submitText = '确定',
  extra,
  onSubmit,
  onClose,
}: {
  title: string;
  fields?: DialogField[];
  submitText?: string;
  extra?: React.ReactNode;
  onSubmit?: (values: Record<string, string | boolean>) => Promise<false | void> | false | void;
  onClose: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!onSubmit) return onClose();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    for (const f of fields) if (f.type === 'checkbox') data[f.name] = data[f.name] ? 'on' : '';
    const values: Record<string, string | boolean> = {};
    for (const f of fields) values[f.name] = f.type === 'checkbox' ? data[f.name] === 'on' : (data[f.name] ?? '');
    setPending(true);
    setError(null);
    try {
      if ((await onSubmit(values)) !== false) onClose();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <form
        id="dialog-form"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 overflow-auto rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={submit}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        {fields.map((f) => (
          <DialogInput key={f.name} field={f} />
        ))}
        {extra}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{onSubmit ? '取消' : '关闭'}</Button>
          {onSubmit && <Button variant="primary" type="submit" disabled={pending}>{pending ? '请稍候…' : submitText}</Button>}
        </div>
      </form>
    </div>
  );
}

function DialogInput({ field: f }: { field: DialogField }) {
  if (f.type === 'checkbox') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input id={`f-${f.name}`} type="checkbox" name={f.name} defaultChecked={!!f.value} /> {f.label}
      </label>
    );
  }
  const id = `f-${f.name}`;
  const control = f.type === 'select' ? (
    <select id={id} name={f.name} defaultValue={String(f.value ?? f.options?.[0]?.[0] ?? '')} className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
      {f.options?.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  ) : f.type === 'textarea' ? (
    <TextArea id={id} name={f.name} defaultValue={String(f.value ?? '')} readOnly={f.readOnly} maxLength={f.maxLength} rows={8} />
  ) : (
    <Input
      id={id}
      name={f.name}
      type={f.type ?? 'text'}
      defaultValue={f.value === undefined ? '' : String(f.value)}
      required={f.required}
      min={f.min}
      max={f.max}
      step={f.step}
      maxLength={f.maxLength}
      placeholder={f.placeholder}
      readOnly={f.readOnly}
      autoComplete="off"
    />
  );
  return (
    <Field label={f.label}>
      {control}
      {f.hint && <span className="mt-1 block text-xs text-slate-500">{f.hint}</span>}
    </Field>
  );
}

/** 二次确认 */
export function Confirm({ title, text, onOk, onClose }: { title: string; text: string; onOk: () => Promise<void> | void; onClose: () => void }) {
  return <Dialog title={title} extra={<p className="text-sm">{text}</p>} submitText="确定" onSubmit={onOk} onClose={onClose} />;
}
