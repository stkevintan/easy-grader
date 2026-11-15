/** 控制台用到的接口类型，对应服务端（只取用到的字段） */

export interface User {
  id: number;
  username: string;
  role: string;
  credits: number;
  createdAt: string;
}

export interface TaskInfo {
  taskId: number;
  judgeId: string;
  platformHost: string;
  scoreStep: number;
  judged: number;
  confirmed: number;
  exam: { exam: string; subject: string; q_index: string };
  question: { type: string; content: Record<string, string | number | undefined> & { score?: number }; extra?: string };
  majorInput: { key: string; name: string; content: string };
}

export interface RecordItem {
  gradingId: string;
  taskId: number;
  score: number;
  maxScore: number;
  reason: string;
  reasons: string[];
  comment: string;
  modifiedScore: number | null;
  isAuto: boolean;
  confidence: number;
  model: string;
  status: 'done' | 'failed';
  charged: boolean;
  error: string;
  createdAt: string;
  confirmedAt: string | null;
}

export interface RecordDetail extends RecordItem {
  ocr: string;
  modelProfile: string;
  latencyMs: number;
  task: {
    examTitle: string;
    questionNo: string;
    subject: string;
    questionType: string;
    platformHost: string;
    maxScore: number;
  } | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MyStats {
  days: number;
  daily: { day: string; done: number; failed: number }[];
  totals: {
    done: number;
    failed: number;
    autoSubmitted: number;
    avgDrift: number | null;
    avgConfidence: number | null;
  };
}

export interface AdapterPreset {
  id: number;
  name: string;
  hostPattern: string;
  pathPattern: string;
  config: unknown;
  note: string;
  createdAt: string;
}

export interface LedgerItem {
  id: number;
  delta: number;
  balanceAfter: number;
  reason: string;
  note: string;
  createdAt: string;
}
