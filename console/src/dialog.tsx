import { useEffect, useRef, useState } from 'react';
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
  // 提交期间不许关闭（取消按钮、Escape、点遮罩）：否则迟到的提交回调会调用共享的 onClose，关掉之后打开的另一个弹窗
  const pendingRef = useRef(false);
  const close = () => {
    if (!pendingRef.current) onClose();
  };
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pendingRef.current) return;
    if (!onSubmit) return onClose();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    for (const f of fields) if (f.type === 'checkbox') data[f.name] = data[f.name] ? 'on' : '';
    const values: Record<string, string | boolean> = {};
    for (const f of fields) values[f.name] = f.type === 'checkbox' ? data[f.name] === 'on' : (data[f.name] ?? '');
    pendingRef.current = true;
    setPending(true);
    setError(null);
    let ok = false;
    try {
      ok = (await onSubmit(values)) !== false;
    } catch (err) {
      setError(err);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
    if (ok) onClose();
  };
  // 用原生 <dialog> 的 showModal：浏览器负责初始焦点、焦点约束、背景不可操作，关闭后把焦点还给打开前的元素
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    if (d && !d.open) d.showModal?.();
    return () => {
      if (d?.open) d.close?.();
      prev?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className="m-auto w-full max-w-lg rounded-lg bg-white p-0 shadow-xl backdrop:bg-black/40 dark:bg-slate-900 dark:text-slate-100"
      // Escape 触发 cancel：交给上层关闭，避免浏览器先关掉 dialog 而 React 状态没变
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      // 点到 dialog 本身（即背景遮罩）时关闭
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <form
        id="dialog-form"
        className="flex max-h-[85vh] flex-col gap-3 overflow-auto p-5"
        onSubmit={submit}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        {fields.map((f) => (
          <DialogInput key={f.name} field={f} />
        ))}
        {extra}
        {/* 始终挂载的 live region：提交失败的错误插进来时屏幕阅读器会播报 */}
        <div role="alert" aria-live="assertive">
          <ErrorText error={error} />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close} disabled={pending}>{onSubmit ? '取消' : '关闭'}</Button>
          {onSubmit && <Button variant="primary" type="submit" disabled={pending}>{pending ? '请稍候…' : submitText}</Button>}
        </div>
      </form>
    </dialog>
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
