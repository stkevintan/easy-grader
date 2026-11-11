/** 适配向导视图 */
import { h } from 'preact';
import { useSignal } from '@preact/signals';
import type { AdapterConfig } from '../../../shared/adapter-config';
import { captureAnswer } from '../../capture';
import { readPaperInfo } from '../../adapter';
import { emptyConfig, pickPics, pickScoreButtons, pickScoreInput, pickSubmit, pickText } from '../../wizard';
import { notice, preset, state, isPicking } from '../store';
import { lookupTask, saveDraft } from '../controller';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Props {
  draft: AdapterConfig;
}

export function AdaptView({ draft }: Props) {
  const tick = useSignal(0);
  const rerender = () => { tick.value++; };
  const picking = isPicking; // shared with panel shell

  const d = draft;
  const hasScore = d.scoreMode === 'input' ? d.scoreInput.selectors.length > 0 : d.scoreButtons.selectors.length > 0;

  const run = (fn: () => Promise<string | null>, hint?: string) => async () => {
    if (hint) notice.value = { kind: 'info', text: hint };
    else notice.value = null;
    isPicking.value = true;
    try {
      const r = await fn();
      notice.value = r ? { kind: 'ok', text: r } : { kind: 'warn', text: '已取消' };
    } catch (e) {
      notice.value = { kind: 'error', text: errText(e) };
    } finally {
      isPicking.value = false;
    }
    rerender();
  };

  const step = (name: string, done: boolean, statusText: string, ...btns: h.JSX.Element[]) => (
    <li>
      <span class="name">{name}</span>
      <span class={`state${done ? ' done' : ''}`} title={statusText}>{statusText}</span>
      {...btns}
    </li>
  );
  const small = (label: string, onClick: () => void) =>
    <button class="btn" onClick={onClick}>{label}</button>;

  const testDraft = async () => {
    try {
      const img = await captureAnswer(d.pics);
      const info = readPaperInfo(d);
      const kb = Math.round((img.length * 3) / 4 / 1024);
      notice.value = {
        kind: 'ok',
        text: `读取成功：答卷图片约 ${kb}KB\n考试：${info.examTitle || '（未读到）'}\n题号：${info.questionNo || '（未读到）'}${info.maxScore ? `\n满分：${info.maxScore}` : ''}`,
      };
    } catch (e) {
      notice.value = { kind: 'error', text: `试读失败：${errText(e)}` };
    }
    rerender();
  };

  const existingConfig = preset.value?.config ?? null;
  const canReturn = !!existingConfig;

  return (
    <div class={picking.value ? 'picking' : ''}>
      <h4>{preset.value ? `重新适配（当前：${preset.value.name}）` : '第一次使用：适配这个阅卷页面'}</h4>
      <p class="muted">按顺序点出页面上的几个位置。点选时不会真的给分或提交。</p>
      <ol class="steps">
        {step('1. 答卷图片',
          d.pics.selectors.length > 0,
          d.pics.selectors.length ? `${d.pics.type}${d.pics.multiple ? ' ×多张' : ''}` : '未选择',
          small('点选', run(() => pickPics(d, false))),
          small('区域截图', run(() => pickPics(d, true))),
        )}
        {step('2. 给分位置', hasScore,
          hasScore ? (d.scoreMode === 'input' ? '输入框' : '打分板') : '未选择',
          small('输入框', run(() => pickScoreInput(d), '请在阅卷平台的分数框里用键盘输入任意一个分数（先别提交）')),
          small('打分板', run(() => pickScoreButtons(d))),
        )}
        {step('3. 提交按钮',
          d.submit.selectors.length > 0,
          d.submit.selectors.length ? '已选择' : '未选择（给分后自动提交可跳过）',
          small('点选', run(() => pickSubmit(d))),
        )}
        {step('4. 考试名称',
          !!(d.examTitle.selectors.length || d.examTitle.fixed),
          d.examTitle.fixed || (d.examTitle.selectors.length ? '已选择' : '未选择'),
          small('点选', run(() => pickText(d, 'examTitle'))),
        )}
        {step('5. 题号',
          !!(d.questionNo.selectors.length || d.questionNo.fixed),
          d.questionNo.fixed || (d.questionNo.selectors.length ? '已选择' : '未选择'),
          small('点选', run(() => pickText(d, 'questionNo'))),
        )}
        {step('6. 满分（可选）',
          !!d.maxScore?.selectors.length,
          d.maxScore?.selectors.length ? '已选择' : '可跳过',
          small('点选', run(() => pickText(d, 'maxScore'))),
        )}
      </ol>

      <label for="eg-exam-fixed">页面上没有考试名称？直接填写：</label>
      <input id="eg-exam-fixed" placeholder="例如：高二期中语文"
        value={d.examTitle.fixed ?? ''}
        onInput={(e) => { d.examTitle.fixed = (e.target as HTMLInputElement).value.trim() || undefined; }} />

      <label for="eg-q-fixed">页面上没有题号？直接填写：</label>
      <input id="eg-q-fixed" placeholder="例如：17"
        value={d.questionNo.fixed ?? ''}
        onInput={(e) => { d.questionNo.fixed = (e.target as HTMLInputElement).value.trim() || undefined; }} />

      <div class="foot">
        <button class="btn" onClick={() => void testDraft()}>试读一次</button>
        <button class="btn primary grow" disabled={!(d.pics.selectors.length > 0 && hasScore)}
          onClick={() => void saveDraft(d)}>保存适配</button>
        {canReturn && (
          <button class="btn" onClick={() => {
            const task = state.value.view === 'adapt' ? null : null; // will re-lookup
            void lookupTask(existingConfig!);
          }}>返回</button>
        )}
      </div>
    </div>
  );
}
