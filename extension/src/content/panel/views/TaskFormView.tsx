/** 题目设置视图（受控表单） */
import { h } from 'preact';
import { useSignal } from '@preact/signals';
import { subjects } from '../store';
import type { TaskForm } from '../forms/task-form';
import { saveTask, startAdapt } from '../controller';
import { state } from '../store';
import type { TaskInfo } from '../../../shared/protocol';

interface Props {
  form: TaskForm;
  existingTask: TaskInfo | null;
}

export function TaskFormView({ form, existingTask }: Props) {
  // 触发重渲染用的 tick
  // A signal read during render creates a subscription.
  // Mutating it in event handlers re-renders the component.
  const tick = useSignal(0);
  void tick.value; // subscribe
  const rerender = () => { tick.value++; };

  const f = form.values;
  const e = form.errors;

  const field = (id: string, label: string, el: h.JSX.Element, error?: string) => (
    <div class={error ? 'field error' : 'field'}>
      <label for={id}>{label}</label>
      {el}
      {error && <span class="field-error">{error}</span>}
    </div>
  );

  const onSave = async () => {
    if (!form.validate()) { rerender(); return; }
    await saveTask(form);
    rerender();
  };

  const majorKey = form.majorKey;

  return (
    <div>
      <h4>题目设置</h4>
      <p class="muted">评分质量主要取决于参考答案和评分细则，写得越具体越准。</p>

      <div class="row">
        <div>{field('eg-exam', '考试名称',
          <input id="eg-exam" value={f.exam} required maxLength={200}
            onInput={(e) => { form.set('exam', (e.target as HTMLInputElement).value); rerender(); }} />,
          e.exam,
        )}</div>
        <div>{field('eg-qno', '题号',
          <input id="eg-qno" value={f.q_index} required maxLength={100}
            onInput={(e) => { form.set('q_index', (e.target as HTMLInputElement).value); rerender(); }} />,
          e.q_index,
        )}</div>
      </div>

      <div class="row">
        <div>{field('eg-subject', '学科',
          <select id="eg-subject" value={f.subject}
            onChange={(e) => { form.set('subject', (e.target as HTMLSelectElement).value); rerender(); }}>
            {subjects.value.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>,
        )}</div>
        <div>{field('eg-max', '满分',
          <input id="eg-max" type="number" min={0.5} max={200} step={0.5} value={f.score} required
            onInput={(e) => { form.set('score', (e.target as HTMLInputElement).value); rerender(); }} />,
          e.score,
        )}</div>
        <div>{field('eg-step', '步长',
          <select id="eg-step" value={f.scoreStep}
            onChange={(e) => { form.set('scoreStep', (e.target as HTMLSelectElement).value); rerender(); }}>
            {[1, 0.5, 2, 5].map((x) => <option key={x} value={x}>{x} 分</option>)}
          </select>,
        )}</div>
      </div>

      {field('eg-qtype', '题型（可选）',
        <input id="eg-qtype" value={f.questionType} maxLength={50}
          placeholder="如：阅读理解 / 作文 / 古诗文翻译"
          onInput={(e) => { form.set('questionType', (e.target as HTMLInputElement).value); rerender(); }} />,
      )}

      {field('eg-qtext', '题干',
        <textarea id="eg-qtext" maxLength={8000} value={f.title}
          placeholder="题干（可选，建议填写）"
          onInput={(e) => { form.set('title', (e.target as HTMLTextAreaElement).value); rerender(); }} />,
      )}

      {field('eg-ref', '参考答案',
        <textarea id="eg-ref" maxLength={8000} value={f.reference}
          placeholder="参考答案"
          onInput={(e) => { form.set('reference', (e.target as HTMLTextAreaElement).value); rerender(); }} />,
      )}

      {field('eg-rubric',
        majorKey === 'title' ? '评分细则（同步题干）' : majorKey === 'reference' ? '评分细则（同步参考答案）' : '评分细则',
        <textarea id="eg-rubric" maxLength={8000} value={f.rubric}
          placeholder='评分细则，例如：答出"思念外婆"得 2 分……'
          onInput={(e) => { form.set('rubric', (e.target as HTMLTextAreaElement).value); rerender(); }} />,
        e.rubric,
      )}

      {form.submitError && <div class="msg error">{form.submitError}</div>}

      <div class="foot">
        <button class="btn primary grow" onClick={() => void onSave()}>保存并开始</button>
        <button class="btn" onClick={() => startAdapt()}>重新适配</button>
        {existingTask && (
          <button class="btn" onClick={() => { state.value = { view: 'ready', task: existingTask }; }}>返回</button>
        )}
      </div>
    </div>
  );
}
