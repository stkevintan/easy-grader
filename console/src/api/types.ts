/** 控制台用到的接口类型，对应服务端（只取用到的字段） */

export interface User {
  id: number;
  username: string;
  role: string;
  credits: number;
  createdAt: string;
  /** 所属组织；没有组织时为 null */
  org?: { id: number; name: string } | null;
}

export interface AdminOrg {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  memberCount: number;
  createdAt: string;
}

export interface OrgMember {
  id: number;
  username: string;
  role: 'user' | 'admin';
  credits: number;
  disabled: boolean;
  judged: number;
  lastJudgeAt: string | null;
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
  userId?: number;
  delta: number;
  balanceAfter: number;
  reason: string;
  note: string;
  createdAt: string;
}

export interface AdminUser {
  id: number;
  username: string;
  role: 'user' | 'admin';
  credits: number;
  disabled: boolean;
  org: { id: number; name: string } | null;
  lastLoginAt: string | null;
  judged: number;
  lastJudgeAt: string | null;
  createdAt: string;
}

export interface AdminCode {
  id: number;
  code: string;
  credits: number;
  usedCount: number;
  maxUses: number;
  disabled: boolean;
  expiresAt: string | null;
  note: string;
  createdAt: string;
}

export interface AdminInvite {
  id: number;
  orgId: number | null;
  usedCount: number;
  maxUses: number;
  disabled: boolean;
  expiresAt: string | null;
  note: string;
}

export interface AdminRecord {
  id: number;
  userId: number;
  username: string | null;
  examTitle: string | null;
  questionNo: string | null;
  platformHost: string | null;
  maxScore: number | null;
  status: 'done' | 'failed';
  aiScore: number | null;
  finalScore: number | null;
  confidence: number | null;
  model: string | null;
  modelProfile: string | null;
  latencyMs: number;
  error: string;
  createdAt: string;
}

export interface AdminPreset {
  id: number;
  name: string;
  hostPattern: string;
  pathPattern: string;
  config: { scoreMode?: string; pics?: { type?: string; multiple?: boolean } };
  scope: 'public' | 'private';
  ownerId: number | null;
  enabled: boolean;
  note: string;
  updatedAt: string;
}

export interface AdminStats {
  users: number;
  tasks: number;
  records: number;
  failed: number;
  creditsOutstanding: number;
  avgLatencyMs: number;
  avgConfidence: number;
  avgDrift: number;
  confirmed: number;
  daily: { day: string; done: number; failed: number; users: number }[];
}

export interface FlagOverride {
  scope: 'global' | 'rollout' | 'org' | 'user';
  targetId: number;
  targetName: string;
  value: unknown;
  percent: number | null;
  valid: boolean;
  updatedAt: string;
}

export interface FlagDef {
  key: string;
  type: 'boolean' | 'number' | 'string';
  default: unknown;
  description: string;
  owner: string;
  removeBy: string;
  client: boolean;
  overrides: FlagOverride[];
}
