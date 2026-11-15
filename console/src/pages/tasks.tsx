import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { TaskInfo } from '../api/types';
import { Button, Card, Empty, ErrorText, Field, Input, TextArea } from '../ui';

/** 服务端 keywords 上限是 2000，其余内容字段是 8000 */
const fieldLimit = (key: string) => (key === 'keywords' ? 2000 : 8000);

const CONTENT_FIELDS: [string, string][] = [
  ['title', '题目'],
  ['reference', '参考答案'],
  ['command', '评分要求'],
  ['resource', '材料'],
  ['target', '作答要求'],
  ['target_command', '作答评分要求'],
  ['keywords', '关键词'],
];

export function TasksPage() {
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api<TaskInfo[]>('GET', '/api/tasks') });
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">阅卷任务</h1>
      <p className="text-sm text-slate-500">任务在扩展里阅卷时自动创建；这里可以修改评分标准和参考答案。考试名称和题号是任务的标识，改动请在阅卷页完成。</p>
      <ErrorText error={tasks.error} />
      {tasks.data && tasks.data.length === 0 && <Empty text="还没有阅卷任务" />}
      {tasks.data?.map((t) => (
        <TaskCard key={t.taskId} task={t} />
      ))}
    </div>
  );
}

function TaskCard({ task }: { task: TaskInfo }) {
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/tasks/${task.taskId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">{task.exam.exam || '未命名考试'} · 第 {task.exam.q_index} 题</div>
          <div className="text-xs text-slate-500">
            {task.exam.subject} · {task.question.type || '未分题型'} · 满分 {task.question.content.score ?? '—'} · 步长 {task.scoreStep} · {task.platformHost}
          </div>
          <div className="mt-1 text-xs text-slate-500">已评 {task.judged} 份，已确认 {task.confirmed} 份</div>
        </div>
        <div className="flex gap-2">
          <Link className="text-sm text-brand" to={`/records?taskId=${task.taskId}`}>记录</Link>
          <Button onClick={() => setEditing((v) => !v)}>{editing ? '收起' : '编辑'}</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (confirm('删除任务会同时删除它的评分记录，确定？')) remove.mutate();
            }}
          >删除</Button>
        </div>
      </div>
      <ErrorText error={remove.error} />
      {editing && <TaskEditor task={task} onDone={() => setEditing(false)} />}
    </Card>
  );
}

function TaskEditor({ task, onDone }: { task: TaskInfo; onDone: () => void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (body: unknown) => api('PUT', '/api/tasks', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onDone();
    },
  });
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    // 从原内容出发，只覆盖表单里的字段，避免丢掉表单没展示的字段
    const content: Record<string, string | number> = { ...task.question.content, score: Number(data.score) };
    for (const [key] of CONTENT_FIELDS) {
      if (key === task.majorInput.key) continue;
      const value = data[key]?.trim() ?? '';
      if (value) content[key] = value;
      else delete content[key];
    }
    // 评分标准是 majorInput.key 指向的字段的唯一编辑入口，避免和内容字段互相覆盖
    const rubric = data.rubric.trim();
    if (rubric) content[task.majorInput.key] = rubric;
    else delete content[task.majorInput.key];
    save.mutate({
      platformHost: task.platformHost,
      exam: { exam: task.exam.exam, subject: task.exam.subject, q_index: task.exam.q_index },
      question: { type: data.type, content, extra: data.extra || undefined },
      majorInput: { key: task.majorInput.key, name: data.rubricName, content: rubric },
      scoreStep: Number(data.scoreStep),
    });
  };
  return (
    <form className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2" onSubmit={onSubmit}>
      <Field label="考试名称"><Input value={task.exam.exam} readOnly /></Field>
      <Field label="题号"><Input value={task.exam.q_index} readOnly /></Field>
      <Field label="题型"><Input name="type" defaultValue={task.question.type} maxLength={50} /></Field>
      <Field label="满分"><Input name="score" type="number" step="0.5" min={0.5} max={200} defaultValue={task.question.content.score} required /></Field>
      <Field label="步长">
        <select name="scoreStep" defaultValue={task.scoreStep} className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
          {[0.5, 1, 2, 5].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      {CONTENT_FIELDS.filter(([key]) => key !== task.majorInput.key).map(([key, label]) => (
        <div key={key} className="md:col-span-2">
          <Field label={label}><TextArea name={key} defaultValue={String(task.question.content[key] ?? '')} maxLength={fieldLimit(key)} /></Field>
        </div>
      ))}
      <div className="md:col-span-2">
        <Field label="补充说明"><TextArea name="extra" defaultValue={task.question.extra ?? ''} maxLength={8000} /></Field>
      </div>
      <Field label="评分标准名称"><Input name="rubricName" defaultValue={task.majorInput.name} maxLength={50} /></Field>
      <div className="md:col-span-2">
        <Field label="评分标准"><TextArea name="rubric" defaultValue={task.majorInput.content} maxLength={fieldLimit(task.majorInput.key)} /></Field>
      </div>
      <div className="flex items-center gap-3 md:col-span-2">
        <Button variant="primary" type="submit" disabled={save.isPending}>{save.isPending ? '保存中…' : '保存'}</Button>
        <ErrorText error={save.error} />
      </div>
    </form>
  );
}
