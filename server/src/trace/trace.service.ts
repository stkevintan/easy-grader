import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import type { GradingTask } from '../entities';

export interface TraceResponse {
  model?: string;
  finishReason?: string;
  content: string;
  /** 推理模型的思考过程（reasoning_content），没有则为空 */
  reasoning: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
  };
}

export interface TraceVerdict {
  score: number;
  confidence: number;
  ocrText: string;
  reasons: string[];
  comment: string;
}

export interface TraceOcr {
  /** 转录阶段用的提示词（不含题目和评分标准） */
  prompt: string;
  /** 转录结果，也是评分阶段使用的固定文字 */
  text: string;
  attempts: number;
  latencyMs: number;
  response?: TraceResponse;
  error?: string;
}

export interface TraceSample {
  score?: number;
  confidence?: number;
  points?: unknown[];
  response?: TraceResponse;
  error?: string;
}

export interface TraceInput {
  recordId: number;
  task: GradingTask;
  imageDataUrl: string;
  sha256: string;
  /** 实际发给模型的提示词，评测时可以直接重放 */
  prompt: string;
  /** 评分提示词与解析规则的版本；每次改提示词、引用校验或汇总逻辑都要加一 */
  promptVersion?: number;
  /** 功能开关 model_profile 选中的模型方案 */
  modelProfile?: string;
  /** 提示词里引用的老师确认示例（只有 recordId 和分数，文字已在 prompt 里） */
  goldExamples?: { recordId: number; score: number }[];
  /** 两阶段评分的第一阶段：纯转录 */
  ocr?: TraceOcr;
  /** 多次采样的每次结果（失败时只有 error） */
  samples?: TraceSample[];
  /** 发请求的次数（含重试），成功时是实际尝试次数 */
  attempts: number;
  latencyMs: number;
  response?: TraceResponse;
  verdict?: TraceVerdict;
  error?: string;
}

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * 把一次评分完整落盘，供离线评测 / 回归测试使用：
 *   data/traces/<recordId>-<sha>.json   题目、提示词、模型输出、思考过程、解析结果
 *   data/traces/<recordId>-<sha>.jpg    答卷图片
 *
 * 默认关闭（SAVE_TRACES=true 才写）。写失败只记日志，绝不影响评分。
 */
@Injectable()
export class TraceService {
  private readonly log = new Logger('Trace');

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  get enabled(): boolean {
    return this.cfg.saveTraces;
  }

  async save(input: TraceInput): Promise<void> {
    if (!this.enabled) return;
    try {
      const mime = input.imageDataUrl.slice(5, input.imageDataUrl.indexOf(';')) || 'image/jpeg';
      const ext = IMAGE_EXT[mime] ?? 'jpg';
      const base = `${input.recordId}-${input.sha256.slice(0, 12)}`;
      const imageFile = `${base}.${ext}`;
      await mkdir(this.cfg.traceDir, { recursive: true });
      await writeFile(join(this.cfg.traceDir, imageFile), Buffer.from(input.imageDataUrl.slice(input.imageDataUrl.indexOf(',') + 1), 'base64'));

      const profile = input.modelProfile ?? 'default';
      const model = { ...this.cfg.model, ...(profile !== 'default' && Object.hasOwn(this.cfg.modelProfiles, profile) ? this.cfg.modelProfiles[profile] : {}) };
      const trace = {
        version: 2,
        promptVersion: input.promptVersion ?? null,
        recordId: input.recordId,
        createdAt: new Date().toISOString(),
        task: {
          id: input.task.id,
          platformHost: input.task.platformHost,
          examTitle: input.task.examTitle,
          questionNo: input.task.questionNo,
          subject: input.task.subject,
          questionType: input.task.questionType,
          maxScore: input.task.maxScore,
          scoreStep: input.task.scoreStep,
          questionText: input.task.questionText,
          referenceAnswer: input.task.referenceAnswer,
          rubric: input.task.rubric,
        },
        image: {
          file: imageFile,
          sha256: input.sha256,
          mime,
        },
        prompt: input.prompt,
        goldExamples: input.goldExamples ?? [],
        ocr: input.ocr ?? null,
        samples: input.samples ?? [],
        modelConfig: {
          profile,
          name: model.name,
          temperature: model.temperature,
          maxTokens: model.maxTokens,
          reasoningEffort: model.reasoningEffort || '(default)',
        },
        attempts: input.attempts,
        latencyMs: input.latencyMs,
        response: input.response ?? null,
        verdict: input.verdict ?? null,
        error: input.error ?? null,
      };
      await writeFile(join(this.cfg.traceDir, `${base}.json`), JSON.stringify(trace, null, 2) + '\n');
    } catch (e) {
      this.log.warn(`保存 trace 失败：${(e as Error).message}`);
    }
  }
}
