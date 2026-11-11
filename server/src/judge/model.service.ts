import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import type { GradingTask } from '../entities';
import { TraceInput, TraceResponse, TraceService } from '../trace/trace.service';
import type { GoldExample } from './gold.service';

export type PointLevel = 'full' | 'partial' | 'none';

/**
 * 评分提示词与解析规则的版本。改提示词、引用校验、分数汇总规则时加一。
 * 1：单阶段整体评分（旧格式）
 * 2：两阶段 + 逐点判定 + 引用校验
 * 3：引用忽略「（划掉：…）」标注；明确要点句是得分单位、标准里的典型事例也算依据
 * 4：majorInput 指向参考答案/题干时，额外带上 question.content.command 作为评分细则
 */
export const PROMPT_VERSION = 4;

/** 模型对评分标准中某一个点的判定；quote 必须能在转录文字里找到原文 */
export interface VerdictPoint {
  rubric: string;
  level: PointLevel;
  /** 该点得分；引用校验失败时会被置 0 */
  delta: number;
  quote: string;
  verified: boolean;
}

export interface ModelVerdict {
  score: number;
  confidence: number;
  ocrText: string;
  reasons: string[];
  comment: string;
  model: string;
  /** 逐点判定；没有输出 points 时为空（兼容旧格式） */
  points?: VerdictPoint[];
  /** 多次采样时各次的分数，用于面板提示不一致 */
  samples?: number[];
  /** 多次采样的最大分差 */
  spread?: number;
}

export class ModelOutputError extends Error {
  /** 已经拿到的模型原始输出，失败时也写进 trace，便于分析截断/格式问题 */
  constructor(message: string, readonly response?: TraceResponse) {
    super(message);
  }
}

/** 上游临时错误（5xx / 429 / 网络中断）：可以重试 */
class RetryableUpstreamError extends ServiceUnavailableException {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 按步长取整并夹到 [0, maxScore] */
export function snapScore(raw: number, maxScore: number, step: number): number {
  if (!Number.isFinite(raw)) throw new ModelOutputError('模型没有给出有效分数');
  const s = step > 0 ? step : 1;
  const snapped = Math.round(raw / s) * s;
  const clamped = Math.min(Math.max(snapped, 0), maxScore);
  return Math.round(clamped * 100) / 100;
}

/** 从模型回复里抠出 JSON：兼容 ```json 代码块、前后有解释文字的情况 */
export function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ModelOutputError('模型回复不是 JSON');
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new ModelOutputError('模型回复的 JSON 无法解析');
  }
}

/** 比较引用和转录文字时忽略空白、标点和序号，保留 □ */
export function normalizeQuote(s: string): string {
  return (
    s
      // 转录时划掉的内容写成「（划掉：…）」；模型引用时通常会省略这层标注，
      // 不先去掉的话，中间插了一段标注的合法原文会被误判成不连续。
      .replace(/[（(]\s*划掉\s*[:：][^）)]*[）)]/g, '')
      .replace(/[\s，。、；：""''“”‘’（）()【】[\]「」…—\-·]/g, '')
  );
}

/**
 * 解析模型回复。
 * source 是学生作答的权威文字（两阶段评分里就是第一阶段的转录）。
 * 传了 source 时，每个得分点的 quote 必须是 source 里的连续原文，否则该点不得分。
 */
export function parseVerdict(
  text: string,
  task: Pick<GradingTask, 'maxScore' | 'scoreStep'>,
  model: string,
  source = '',
): ModelVerdict {
  const j = extractJson(text);
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const reasons = Array.isArray(j.reasons)
    ? j.reasons.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 300)).slice(0, 10)
    : [];
  const ocrText = str(j.ocr_text ?? j.ocrText, 4000);
  const quoteSource = normalizeQuote(source || ocrText);

  const points: VerdictPoint[] = [];
  if (Array.isArray(j.points)) {
    for (const raw of j.points.slice(0, 12)) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const rawDelta = num(p.delta);
      const level: PointLevel =
        p.level === 'full' || p.level === 'partial' || p.level === 'none'
          ? p.level
          : Number.isFinite(rawDelta) && rawDelta > 0
            ? 'partial'
            : 'none';
      const quote = str(p.quote, 300);
      const nQuote = normalizeQuote(quote);
      // 没有可对照的文字时无法校验，按原样接受；有转录时必须有原文引用
      const verified = level === 'none' || !quoteSource || (nQuote.length >= 2 && quoteSource.includes(nQuote));
      const delta =
        level === 'none' || !verified || !Number.isFinite(rawDelta)
          ? 0
          : Math.min(Math.max(rawDelta, 0), task.maxScore);
      points.push({ rubric: str(p.rubric, 20), level, delta, quote, verified });
    }
  }

  let score: number;
  if (points.length) {
    // 总分由逐点得分相加，服务器统一取整和夹取，不让模型自己心算
    score = snapScore(
      points.reduce((s, p) => s + p.delta, 0),
      task.maxScore,
      task.scoreStep,
    );
  } else {
    score = snapScore(num(j.score), task.maxScore, task.scoreStep);
  }

  const dropped = points.filter((p) => !p.verified && p.level !== 'none');
  if (dropped.length) {
    reasons.push(`未采信：${dropped.map((p) => p.rubric || '某点').join('、')} 的引用没有在答卷文字中找到，已不计分`);
  }

  const conf = num(j.confidence);
  let confidence = Number.isFinite(conf) ? Math.min(Math.max(conf > 1 ? conf / 100 : conf, 0), 1) : 0.5;
  if (dropped.length) confidence = Math.round(Math.max(0.05, confidence - 0.1 * dropped.length) * 100) / 100;

  return {
    score,
    confidence,
    ocrText,
    reasons,
    comment: str(j.comment, 1000),
    model,
    ...(points.length ? { points } : {}),
  };
}

/** 第一阶段：只转录，不带题目、参考答案和评分标准，避免模型按得分点“补全”文字 */
export function buildOcrPrompt(): string {
  return [
    '请逐字转录图片中学生手写的答卷内容。',
    '要求：',
    '1. 只转录学生手写的内容，忽略印刷的题目、题号、分值、页眉页脚。',
    '2. 只写你确实能看清的字；无法辨认的字用 □ 代替，看不清几个字就写几个 □。',
    '3. 严禁根据常识、上下文或常见表述补全任何词语，宁可写 □。',
    '4. 保留学生原有的序号和换行；划掉的内容用「（划掉：…）」标出。',
    '5. 如果图片中没有手写内容，只输出：（空白）',
    '直接输出转录文字，不要解释，不要输出 JSON。',
  ].join('\n');
}

/** 转录结果是否表示空白答卷 */
export function isBlankOcr(text: string): boolean {
  const t = text.replace(/[\s（）()【】[\]「」]/g, '');
  return t === '' || t === '空白';
}

export function buildPrompt(task: GradingTask, examples: GoldExample[] = [], transcript?: string): string {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const content = task.question?.content ?? {};
  const questionType = text(task.question?.type) || task.questionType;
  const title = text(content.title) || task.questionText;
  const reference = text(content.reference) || task.referenceAnswer;
  const command = text(content.command);
  const resource = text(content.resource);
  const target = text(content.target);
  const targetCommand = text(content.target_command);
  const keywords = text(content.keywords);
  const extra = text(task.question?.extra);
  const rubric = text(task.majorInput?.content) || task.rubric;
  const parts = [
    `你是一名经验丰富、严格公正的${task.subject}阅卷老师。请根据下面的题目、参考答案和评分标准，给这份学生手写答卷打分。`,
    `满分：${task.maxScore} 分；给分步长：${task.scoreStep} 分。`,
  ];
  if (questionType) parts.push(`题型：${questionType}`);
  if (resource) parts.push(`【材料】\n${resource}`);
  if (title) parts.push(`【题目】\n${title}`);
  if (target && target !== title) parts.push(`【题目/写作目标】\n${target}`);
  if (targetCommand) parts.push(`【题目要求】\n${targetCommand}`);
  if (reference && reference !== rubric) parts.push(`【参考答案】\n${reference}`);
  if (rubric) {
    parts.push(`【评分标准】\n${rubric}`);
    parts.push(
      [
        '【评分标准的读法】',
        '每个标准点由“要点句”和后面的解释组成。学生答出要点句所指向的措施或方向，即算答出该点，给 full；解释里的具体例子、效果和措辞不要求全部出现，也不能因为学生没写解释就降为 partial。',
        '只有学生表述笼统、与该点方向只是部分沾边，或只说出了其中一半时，才给 partial。',
        '评分标准里用“如……”举的典型事例，是判断该点是否答出的依据之一；学生答到这些事例，同样算答出对应要点，不要因为学生没有复述要点句而判为未答出。',
        '同一段作答如果确实同时对应多个不同标准点，可以分别计分；但不要把同一句话拆成多个点重复计分。',
      ].join('\n'),
    );
  }
  // majorInput 可能指向参考答案/题干；评分细则单独带上，避免被覆盖后丢失
  if (command && command !== rubric && command !== reference) parts.push(`【评分细则】\n${command}`);
  if (keywords) parts.push(`【关键词】\n${keywords}`);
  if (extra) parts.push(`【补充说明】\n${extra}`);
  if (examples.length) {
    parts.push(
      [
        '【老师已确认的评分示例】',
        '以下是本题其他学生的作答（识别文字）和老师最终确认的分数，用于校准本题的评分尺度：',
        ...examples.map((e, i) => `示例${i + 1}（${e.score} 分）：${e.ocrText}`),
        '这些示例只反映评分尺度，不代表标准答案，也不能照搬分数。请仍然以【评分标准】为准，独立判断这份答卷。',
      ].join('\n'),
    );
  }
  if (transcript) {
    parts.push(
      [
        '【已转录的答卷文字】',
        transcript,
        '这段文字由独立的转录环节逐字生成，□ 表示无法辨认。评分时学生作答内容以这段文字为准，不要重新逐字识别图片，也不要根据评分标准补全其中没有的词；ocr_text 字段留空字符串。',
      ].join('\n'),
    );
  }
  parts.push(
    [
      '要求：',
      transcript
        ? '1. 学生作答内容以【已转录的答卷文字】为准，不要从图片重新识别或补全文字。'
        : '1. 先逐字识别答卷内容；看不清的地方用 □ 代替，不要臆测。',
      '2. 逐条对照评分标准输出 points：每个标准点给出 level（full 完整 / partial 部分 / none 未答出）和该点得分 delta。',
      transcript
        ? '3. 每个 full / partial 点的 quote 必须从【已转录的答卷文字】中原文摘录一段连续文字；没有对应原文时 quote 留空、level 写 none、delta 写 0。不得改写、拼接或从图片中另找。'
        : '3. 每个 full / partial 点的 quote 必须从你识别出的答卷文字中原文摘录一段连续文字；没有对应原文时不得给分。',
      '4. 判断语义是否对应，不要因为出现参考答案里的词就给分，也不要因为措辞不同就扣分。',
      '5. 总分由各点 delta 相加后按评分标准汇总（如“答任意三点得满分”），不要重复计算同一个点。',
      '6. 答卷空白、与题目无关或无法辨认时给 0 分，并把 confidence 设低。',
      '7. 只输出一个 JSON 对象，不要输出任何其他文字：',
      transcript
        ? '{"points": [{"rubric": "①", "level": "full", "delta": 2, "quote": "转录文字中的原文片段"}], "confidence": 0到1之间的数字, "reasons": ["得分/扣分点说明"], "comment": "一句话评语"}'
        : '{"points": [{"rubric": "①", "level": "full", "delta": 2, "quote": "识别文字中的原文片段"}], "confidence": 0到1之间的数字, "ocr_text": "识别出的答卷文字", "reasons": ["得分/扣分点说明"], "comment": "一句话评语"}',
    ].join('\n'),
  );
  return parts.join('\n\n');
}

/** OpenAI 兼容的 Chat Completions 视觉模型；未配置 API Key 时退化为 mock */
@Injectable()
export class ModelService {
  private readonly log = new Logger('Model');

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly trace: TraceService,
  ) {
    if (!this.isConfigured) this.log.warn('未配置 MODEL_API_KEY，评分使用 mock（随机分数，仅用于联调）');
  }

  get isConfigured(): boolean {
    return Boolean(this.cfg.model.apiKey && this.cfg.model.baseUrl && this.cfg.model.name);
  }

  async grade(
    task: GradingTask,
    imageDataUrl: string,
    sha256: string,
    recordId: number,
    examples: GoldExample[] = [],
  ): Promise<ModelVerdict> {
    if (!this.isConfigured) return this.mock(task, sha256);

    const started = Date.now();
    const goldExamples = examples.map((e) => ({ recordId: e.recordId, score: e.score }));
    let prompt = '';
    let attempts = 0;
    let ocr: TraceInput['ocr'] | undefined;
    let stage: 'ocr' | 'score' = this.cfg.ocr.twoPass ? 'ocr' : 'score';

    try {
      // 第一阶段：纯转录。提示词里没有题目、参考答案和评分标准，避免模型按得分点补全文字
      let transcript = '';
      if (this.cfg.ocr.twoPass) {
        const ocrPrompt = buildOcrPrompt();
        const ocrStarted = Date.now();
        try {
          const r = await this.withRetry('识别答卷', () => {
            attempts += 1;
            return this.requestCompletion(imageDataUrl, ocrPrompt);
          });
          transcript = r.text.trim().slice(0, 4000);
          ocr = {
            prompt: ocrPrompt,
            text: transcript,
            attempts,
            latencyMs: Date.now() - ocrStarted,
            response: r.response,
          };
        } catch (e) {
          ocr = {
            prompt: ocrPrompt,
            text: '',
            attempts,
            latencyMs: Date.now() - ocrStarted,
            response: e instanceof ModelOutputError ? e.response : undefined,
            error: `${(e as Error).name}: ${(e as Error).message}`,
          };
          throw e;
        }
        if (isBlankOcr(transcript)) {
          const verdict: ModelVerdict = {
            score: 0,
            confidence: 0.2,
            ocrText: transcript || '（空白）',
            reasons: ['图片中没有可辨认的手写答案'],
            comment: '未识别到作答',
            model: ocr.response?.model || this.cfg.model.name,
          };
          await this.trace.save({
            recordId,
            task,
            imageDataUrl,
            sha256,
            prompt: '',
            promptVersion: PROMPT_VERSION,
            goldExamples,
            attempts,
            latencyMs: Date.now() - started,
            ocr,
            verdict: {
              score: verdict.score,
              confidence: verdict.confidence,
              ocrText: verdict.ocrText,
              reasons: verdict.reasons,
              comment: verdict.comment,
            },
          });
          return verdict;
        }
      }

      // 第二阶段：拿固定的转录文字 + 评分标准打分
      stage = 'score';
      prompt = buildPrompt(task, examples, transcript || undefined);
      // 默认不再把图片发给评分阶段：学生作答只以转录文字为准，从机制上杜绝重新读图编造
      const image = this.cfg.model.scoreWithImage ? imageDataUrl : undefined;
      const sampleCount = this.cfg.model.sampleCount;
      const results = await Promise.allSettled(
        Array.from({ length: sampleCount }, () =>
          this.withRetry('评分', () => {
            attempts += 1;
            return this.requestVerdict(task, image, prompt, transcript || undefined);
          }),
        ),
      );
      const ok = results
        .filter((r): r is PromiseFulfilledResult<{ verdict: ModelVerdict; response: TraceResponse }> => r.status === 'fulfilled')
        .map((r) => r.value);
      if (!ok.length) {
        const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        throw firstError?.reason ?? new ServiceUnavailableException('评分失败');
      }

      // 多次采样取中位数；分差越大越可能落在评分标准的边界上
      const sampleScores = ok.map((x) => x.verdict.score).sort((a, b) => a - b);
      const median = sampleScores[Math.floor((sampleScores.length - 1) / 2)];
      const chosen = ok.find((x) => x.verdict.score === median) ?? ok[0];
      const spread = sampleScores[sampleScores.length - 1] - sampleScores[0];
      const verdict: ModelVerdict = { ...chosen.verdict };
      if (transcript) verdict.ocrText = transcript;
      if (sampleCount > 1) {
        verdict.samples = sampleScores;
        verdict.spread = spread;
        if (spread > 0) {
          verdict.confidence = Math.round(Math.max(0.05, verdict.confidence * (spread >= 2 ? 0.7 : 0.85)) * 100) / 100;
        }
      }

      await this.trace.save({
        recordId,
        task,
        imageDataUrl,
        sha256,
        prompt,
        promptVersion: PROMPT_VERSION,
        goldExamples,
        attempts,
        latencyMs: Date.now() - started,
        ocr,
        response: chosen.response,
        samples: results.map((r) =>
          r.status === 'fulfilled'
            ? {
                score: r.value.verdict.score,
                confidence: r.value.verdict.confidence,
                points: r.value.verdict.points,
                response: r.value.response,
              }
            : { error: `${(r.reason as Error)?.name ?? 'Error'}: ${(r.reason as Error)?.message ?? String(r.reason)}` },
        ),
        verdict: {
          score: verdict.score,
          confidence: verdict.confidence,
          ocrText: verdict.ocrText,
          reasons: verdict.reasons,
          comment: verdict.comment,
        },
      });
      return verdict;
    } catch (e) {
      await this.trace.save({
        recordId,
        task,
        imageDataUrl,
        sha256,
        prompt,
        promptVersion: PROMPT_VERSION,
        goldExamples,
        attempts,
        latencyMs: Date.now() - started,
        ocr,
        // 评分阶段失败时把原始回复也留下，便于分析截断/格式问题；识别阶段的回复已在 ocr 里
        response: stage === 'score' && e instanceof ModelOutputError ? e.response : undefined,
        error: `${(e as Error).name}: ${(e as Error).message}`,
      });
      throw e;
    }
  }

  /** 可重试上游错误时指数退避；OCR 和评分两个阶段各自重试 */
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const { maxRetries, retryDelayMs } = this.cfg.model;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof RetryableUpstreamError) || attempt >= maxRetries) throw e;
        const wait = retryDelayMs * 2 ** attempt;
        this.log.warn(`${label}：${(e as Error).message}，${wait}ms 后重试（${attempt + 1}/${maxRetries}）`);
        await sleep(wait);
      }
    }
  }

  private async requestVerdict(
    task: GradingTask,
    imageDataUrl: string | undefined,
    prompt: string,
    source?: string,
  ): Promise<{ verdict: ModelVerdict; response: TraceResponse }> {
    const { text, response } = await this.requestCompletion(imageDataUrl, prompt);
    try {
      return { verdict: parseVerdict(text, task, response.model || this.cfg.model.name, source), response };
    } catch (e) {
      if (e instanceof ModelOutputError) throw new ModelOutputError(e.message, response);
      throw e;
    }
  }

  private async requestCompletion(
    imageDataUrl: string | undefined,
    prompt: string,
  ): Promise<{ text: string; response: TraceResponse }> {
    const { baseUrl, apiKey, name, timeoutMs, temperature, maxTokens, reasoningEffort } = this.cfg.model;
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: name,
          temperature,
          max_tokens: maxTokens,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                ...(imageDataUrl ? [{ type: 'image_url', image_url: { url: imageDataUrl } }] : []),
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timeout = (e as Error).name === 'TimeoutError';
      const msg = timeout ? '模型响应超时' : '无法连接模型服务';
      this.log.error(`${msg}: ${(e as Error).message}`);
      // 超时和连接失败都可能是上游临时抖动，按可重试处理；总时长由扩展侧的超时上限兜底
      throw new RetryableUpstreamError(msg);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500);
      this.log.error(`模型服务返回 HTTP ${res.status}: ${body}`);
      const msg = `模型服务返回错误（HTTP ${res.status}）`;
      const transient = res.status === 408 || res.status === 429 || res.status >= 500;
      throw transient ? new RetryableUpstreamError(msg) : new ServiceUnavailableException(msg);
    }
    let data: {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string }[];
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new RetryableUpstreamError('模型服务返回了无法解析的响应');
    }
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((c: { text?: string }) => c?.text ?? '').join('')
          : '';
    const reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : '';
    const response: TraceResponse = {
      model: data.model || name,
      finishReason: choice?.finish_reason,
      content: text,
      reasoning,
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
      },
    };
    if (!text) {
      const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
      if (choice?.finish_reason === 'length') {
        throw new ModelOutputError(
          `模型把 ${maxTokens} 个输出 token 用完了（其中推理占 ${reasoningTokens ?? '未知'}），正文为空；请调大 MODEL_MAX_TOKENS`,
          response,
        );
      }
      throw new ModelOutputError(`模型没有返回内容（finish_reason=${choice?.finish_reason ?? '无'}）`, response);
    }
    if (choice?.finish_reason === 'length') {
      this.log.warn(`模型输出被截断（max_tokens=${maxTokens}），JSON 可能不完整`);
    }
    return { text, response };
  }

  /** 由图片哈希决定的伪随机分数，同一张图结果稳定 */
  private async mock(task: GradingTask, sha256: string): Promise<ModelVerdict> {
    await new Promise((r) => setTimeout(r, 300));
    const ratio = parseInt(sha256.slice(0, 8), 16) / 0xffffffff;
    const score = snapScore(task.maxScore * (0.4 + ratio * 0.6), task.maxScore, task.scoreStep);
    return {
      score,
      confidence: 0.3,
      ocrText: '（mock 模式不识别文字）',
      reasons: ['当前为 mock 评分：服务端未配置 MODEL_API_KEY', '分数由图片哈希生成，仅用于联调流程'],
      comment: 'mock 评分，请勿用于真实阅卷',
      model: 'mock',
    };
  }
}
