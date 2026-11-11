/**
 * TaskForm:受控表单模型
 *
 * 所有编辑保存在这里；render/校验/服务端错误不会重建字段。
 * 只有保存成功后（`commit(task)`）才把 baseline 替换为服务端返回值。
 */
import type { MajorInput, QuestionContent, QuestionInfo, TaskInfo, TaskInput } from '../../../shared/protocol';

export interface TaskFormValues {
  exam: string;
  q_index: string;
  subject: string;
  score: string;    // 保持字符串，校验时转数字
  scoreStep: string;
  questionType: string;
  title: string;
  reference: string;
  rubric: string;   // 显示给老师的评分依据内容
}

export interface TaskFormErrors {
  [field: string]: string | undefined;
}

/** 包含服务端返回的原始任务（用于合并未展示字段）和当前编辑草稿 */
export class TaskForm {
  /** 服务端最后返回的任务，作为合并基准 */
  private baseline: TaskInfo | null;
  values: TaskFormValues;
  errors: TaskFormErrors = {};
  submitError: string | null = null;

  constructor(task: TaskInfo | null, fromPage: { examTitle: string; questionNo: string; maxScore: number | null }) {
    this.baseline = task;
    const content = task?.question.content ?? {};
    const majorKey = task?.majorInput.key ?? 'command';
    this.values = {
      exam:         task?.exam.exam         ?? fromPage.examTitle,
      q_index:      task?.exam.q_index      ?? fromPage.questionNo,
      subject:      task?.exam.subject      ?? '语文',
      score:        String(content.score    ?? fromPage.maxScore ?? ''),
      scoreStep:    String(task?.scoreStep  ?? 1),
      questionType: task?.question.type     ?? '',
      title:        String(content.title    ?? ''),
      reference:    String(content.reference ?? ''),
      // 评分依据初始化：先用 majorKey 指向的字段，再回退到 majorInput.content / command
      rubric:       String(content[majorKey] ?? task?.majorInput.content ?? content.command ?? ''),
    };
  }

  /** 更新单个字段，并维持 majorInput 双向同步 */
  set<K extends keyof TaskFormValues>(field: K, value: string) {
    this.values[field] = value;
    this.errors[field] = undefined;
    this.submitError = null;

    const majorKey = this.baseline?.majorInput.key ?? 'command';
    // 题干/参考答案与评分依据双向同步
    if (field === 'title' && majorKey === 'title') this.values.rubric = value;
    if (field === 'reference' && majorKey === 'reference') this.values.rubric = value;
    if (field === 'rubric') {
      if (majorKey === 'title') this.values.title = value;
      else if (majorKey === 'reference') this.values.reference = value;
    }
  }

  /** 校验，返回是否通过 */
  validate(): boolean {
    const e: TaskFormErrors = {};
    if (!this.values.exam.trim()) e.exam = '请填写考试名称';
    if (!this.values.q_index.trim()) e.q_index = '请填写题号';
    const score = Number(this.values.score);
    if (!(score >= 0.5 && score <= 200)) e.score = '满分需在 0.5–200 之间';
    const majorKey = this.baseline?.majorInput.key ?? 'command';
    const preservedCommand = majorKey !== 'command'
      ? String(this.baseline?.question.content.command ?? '').trim()
      : '';
    if (!this.values.reference.trim() && !this.values.rubric.trim() && !preservedCommand) {
      e.rubric = '参考答案和评分细则至少填一项';
    }
    this.errors = e;
    return Object.keys(e).length === 0;
  }

  /** 把草稿序列化成 TaskInput（合并 baseline 中未展示的字段） */
  toTaskInput(platformHost: string): TaskInput {
    const prev = this.baseline;
    const prevContent: QuestionContent = prev?.question.content ?? {};
    const prevMajor: MajorInput | undefined = prev?.majorInput;
    const majorKey = prevMajor?.key ?? 'command';
    const score = Number(this.values.score);

    const content: QuestionContent = {
      // 保留未展示的字段（resource / target / keywords 等）
      ...prevContent,
      score,
      title:     this.values.title.trim(),
      reference: this.values.reference.trim(),
      // 只有 majorKey === command 时才更新 command（否则由 majorInput.content 覆盖）
      ...(majorKey === 'command' ? { command: this.values.rubric.trim() } : {}),
    };

    const question: QuestionInfo = {
      type: this.values.questionType.trim(),
      content,
      ...(prev?.question.extra ? { extra: prev.question.extra } : {}),
    };

    return {
      platformHost,
      scoreStep: Number(this.values.scoreStep),
      exam: {
        exam:    this.values.exam.trim(),
        subject: this.values.subject,
        q_index: this.values.q_index.trim(),
      },
      question,
      majorInput: {
        key:     majorKey,
        name:    prevMajor?.name ?? '评分细则',
        content: this.values.rubric.trim(),
      },
    };
  }

  /** 保存成功后更新 baseline */
  commit(task: TaskInfo) {
    this.baseline = task;
    this.errors = {};
    this.submitError = null;
  }

  get majorKey() {
    return this.baseline?.majorInput.key ?? 'command';
  }
}
