import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { GradingTask, JudgeRecord } from '../entities';
import { SUBJECTS, type UpsertTaskDto } from './judge.dto';

/**
 * 对齐咖喱阅卷的任务结构：
 *
 *   taskInfo = { taskId, judgeId, exam, question, majorInput }
 *
 * `question.content` 按题型放不同的字段（title / reference / command /
 * resource / target / target_command …），`majorInput` 指向其中作为评分依据的那一项。
 * 数据库仍保留扁平的 examTitle / questionNo / … 列用于索引和模型提示词，
 * JSON 列是任务结构的来源。
 */
export interface ExamInfo {
  exam: string;
  subject: string;
  q_index: string;
}

export type QuestionContent = Record<string, string | number | undefined> & { score?: number };

export interface QuestionInfo {
  type: string;
  content: QuestionContent;
  extra?: string;
}

export interface MajorInput {
  key: string;
  name: string;
  content: string;
}

export interface TaskInfo {
  taskId: number;
  judgeId: string;
  platformHost: string;
  scoreStep: number;
  exam: ExamInfo;
  question: QuestionInfo;
  majorInput: MajorInput;
}

/** 评分结果；字段名与咖喱阅卷的 judge / submitScore 对齐 */
export interface GradingInfo {
  gradingId: string;
  taskId: number;
  score: number;
  maxScore: number;
  reason: string;
  ocr: string;
  modifiedScore: number | null;
  isAuto: boolean;
  confidence: number;
  reasons: string[];
  comment: string;
  model: string;
  cached: boolean;
  balance: number;
  samples?: number[];
  scoreSpread?: number;
}

export function newJudgeId(): string {
  return `j_${randomBytes(16).toString('hex')}`;
}

export function newGradingId(): string {
  return `g_${randomBytes(16).toString('hex')}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** 实体 → 原版 taskInfo 结构 */
export function toTaskInfo(t: GradingTask): TaskInfo {
  const exam = t.exam!;
  const question = t.question!;
  const majorInput = t.majorInput!;
  const content: QuestionContent = {
    ...question.content,
    score: Number(question.content.score),
  };
  return {
    taskId: t.id,
    judgeId: t.judgeId ?? '',
    platformHost: t.platformHost,
    scoreStep: t.scoreStep,
    exam,
    question: {
      type: question.type ?? '',
      content,
      ...(question.extra ? { extra: question.extra } : {}),
    },
    majorInput,
  };
}

export interface NormalizedTask {
  exam: ExamInfo;
  question: QuestionInfo;
  majorInput: MajorInput;
  /** 供数据库扁平列、索引和模型提示词使用 */
  flat: {
    examTitle: string;
    questionNo: string;
    subject: string;
    questionType: string;
    maxScore: number;
    questionText: string;
    referenceAnswer: string;
    rubric: string;
  };
}

/** 请求 → 任务结构 */
export function normalizeTaskInput(dto: UpsertTaskDto): NormalizedTask {
  const exam: ExamInfo = {
    exam: dto.exam.exam.trim(),
    subject: dto.exam.subject,
    q_index: dto.exam.q_index.trim(),
  };
  if (!exam.exam) throw new BadRequestException('请填写考试名称');
  if (!exam.q_index) throw new BadRequestException('请填写题号');
  if (!SUBJECTS.includes(exam.subject)) throw new BadRequestException(`学科必须是：${SUBJECTS.join('、')}`);

  const content: QuestionContent = { ...dto.question.content };
  const score = Number(content.score);
  if (!Number.isFinite(score) || score < 0.5 || score > 200) throw new BadRequestException('请填写满分（0.5–200）');
  content.score = score;

  const majorInput: MajorInput = {
    key: str(dto.majorInput?.key || 'command'),
    name: str(dto.majorInput?.name || '评分细则'),
    content: str(dto.majorInput?.content ?? content.command),
  };
  content.command = majorInput.content;

  const type = dto.question.type.trim();
  const extra = str(dto.question.extra).trim();
  const question: QuestionInfo = {
    type,
    content,
    ...(extra ? { extra } : {}),
  };

  return {
    exam,
    question,
    majorInput,
    flat: {
      examTitle: exam.exam,
      questionNo: exam.q_index,
      subject: exam.subject,
      questionType: type,
      maxScore: score,
      questionText: str(content.title),
      referenceAnswer: str(content.reference),
      rubric: majorInput.content,
    },
  };
}

export function toGradingInfo(
  r: JudgeRecord,
  task: GradingTask,
  cached: boolean,
  balance: number,
  extra: { samples?: number[]; scoreSpread?: number } = {},
): GradingInfo {
  return {
    gradingId: r.gradingId ?? '',
    taskId: task.id,
    score: r.aiScore ?? 0,
    maxScore: task.maxScore,
    reason: (r.reasons ?? []).join('\n') || r.comment,
    ocr: r.ocrText,
    modifiedScore: r.finalScore,
    isAuto: r.autoSubmitted,
    confidence: r.confidence ?? 0,
    reasons: r.reasons ?? [],
    comment: r.comment,
    model: r.model,
    cached,
    balance,
    ...extra,
  };
}
