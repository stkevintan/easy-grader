#!/usr/bin/env node
/**
 * 用 data/traces 里保存的评分记录做离线评测。
 *
 * 用法（在 server/ 目录下）：
 *   pnpm bench                          # 汇总统计：耗时、思考 token、和老师最终分的偏差
 *   pnpm bench --json                   # 额外输出 dataset.jsonl，方便喂给别的评测脚本
 *   pnpm bench --replay=none --limit=20 # 用保存的图片和提示词，改用 none 重新跑 20 份
 *   pnpm bench --replay=low --limit=20  # 对照组
 *
 * 需要先在 .env 里打开 SAVE_TRACES=true，并让老师正常确认过分数（finalScore）。
 * replay 会真实调用模型、消耗额度，必须显式指定。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);

function readEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = readEnv(resolve('.env'));
const traceDir = resolve(args.dir || env.TRACE_DIR || 'data/traces');

function loadTraces() {
  if (!existsSync(traceDir)) {
    console.error(`没有找到 trace 目录：${traceDir}\n先在 .env 里设置 SAVE_TRACES=true 并跑几次评分。`);
    process.exit(1);
  }
  const traces = [];
  for (const f of readdirSync(traceDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const t = JSON.parse(readFileSync(join(traceDir, f), 'utf8'));
      if (t && t.recordId && t.task) traces.push({ ...t, file: join(traceDir, f) });
    } catch {
      /* 损坏的文件跳过 */
    }
  }
  return traces.sort((a, b) => a.recordId - b.recordId);
}

function loadLabels(traces) {
  const dbPath = resolve(env.DB_PATH || 'data/app.db');
  if (!existsSync(dbPath)) return new Map();
  const db = new Database(dbPath, { readonly: true });
  const ids = traces.map((t) => t.recordId);
  const map = new Map();
  try {
    const stmt = db.prepare('SELECT id, finalScore, autoSubmitted FROM judge_records WHERE id = ?');
    for (const id of ids) {
      const r = stmt.get(id);
      if (r) map.set(id, { finalScore: r.finalScore, autoSubmitted: !!r.autoSubmitted });
    }
  } finally {
    db.close();
  }
  return map;
}

const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');

function latencyStats(rows) {
  const ms = rows.map((r) => r.latencyMs).filter(Number.isFinite);
  return `avg ${fmt(avg(ms) / 1000)}s  p50 ${fmt(pct(ms, 0.5) / 1000)}s  p90 ${fmt(pct(ms, 0.9) / 1000)}s`;
}

function tokenStats(rows) {
  // 有多次采样时按每次调用统计，不然会把 3 次采样的 token 少算成 1 次
  const responses = rows.flatMap((r) =>
    r.samples?.length ? r.samples.map((s) => s.response).filter(Boolean) : [r.response],
  );
  const rt = responses.map((r) => r?.usage?.reasoningTokens).filter(Number.isFinite);
  const ct = responses.map((r) => r?.usage?.completionTokens).filter(Number.isFinite);
  return `思考 token avg ${fmt(avg(rt), 0)} p50 ${fmt(pct(rt, 0.5), 0)}；输出 token avg ${fmt(avg(ct), 0)}（按单次调用统计）`;
}

/** 有 finalScore 的样本：AI 分与老师最终分的偏差 */
function accuracy(rows, labels, scoreOf = (r) => r.verdict?.score) {
  const pairs = rows
    .map((r) => {
      const l = labels.get(r.recordId);
      const ai = scoreOf(r);
      return l && Number.isFinite(l.finalScore) && Number.isFinite(ai) ? { ai, final: l.finalScore, auto: l.autoSubmitted } : null;
    })
    .filter(Boolean);
  if (!pairs.length) return { n: 0 };
  const diffs = pairs.map((p) => p.ai - p.final);
  const abs = diffs.map(Math.abs);
  const manual = pairs.filter((p) => !p.auto);
  const manualDiffs = manual.map((p) => p.ai - p.final);
  return {
    n: pairs.length,
    exact: pairs.filter((p) => p.ai === p.final).length / pairs.length,
    within1: pairs.filter((p) => Math.abs(p.ai - p.final) <= 1).length / pairs.length,
    mae: avg(abs),
    bias: avg(diffs),
    manualN: manual.length,
    manualMae: avg(manualDiffs.map(Math.abs)),
    manualExact: manual.length ? manual.filter((p) => p.ai === p.final).length / manual.length : NaN,
  };
}

function printAccuracy(label, a) {
  if (!a.n) {
    console.log(`  ${label}: 没有可对比的最终分`);
    return;
  }
  console.log(`  ${label}: n=${a.n}  完全一致 ${fmt(a.exact * 100)}%  ±1分内 ${fmt(a.within1 * 100)}%  MAE ${fmt(a.mae, 2)}  偏差 ${fmt(a.bias, 2)}`);
  if (a.manualN) console.log(`    仅人工确认的 ${a.manualN} 份：完全一致 ${fmt(a.manualExact * 100)}%  MAE ${fmt(a.manualMae, 2)}`);
}

function summarize(traces) {
  const ok = traces.filter((t) => t.verdict && t.response);
  const bad = traces.filter((t) => t.error);
  const byEffort = new Map();
  for (const t of ok) {
    const k = t.modelConfig?.reasoningEffort ?? '?';
    byEffort.set(k, [...(byEffort.get(k) ?? []), t]);
  }
  const labels = loadLabels(traces);
  console.log(`trace 总数 ${traces.length}：成功 ${ok.length}，失败 ${bad.length}`);
  const byPrompt = new Map();
  for (const t of traces) {
    const k = t.promptVersion ?? '旧（无版本号）';
    byPrompt.set(k, (byPrompt.get(k) ?? 0) + 1);
  }
  console.log(`  提示词版本：${[...byPrompt.entries()].map(([k, v]) => `${k} ${v} 份`).join('，')}`);
  for (const [effort, rows] of byEffort) {
    console.log(`\n[reasoning_effort=${effort}] ${rows.length} 份`);
    console.log(`  ${latencyStats(rows)}`);
    const ocrMs = rows.map((r) => r.ocr?.latencyMs).filter(Number.isFinite);
    if (ocrMs.length) console.log(`  其中纯转录 avg ${fmt(avg(ocrMs) / 1000)}s  p50 ${fmt(pct(ocrMs, 0.5) / 1000)}s`);
    console.log(`  ${tokenStats(rows)}`);
    printAccuracy('对比老师最终分', accuracy(rows, labels));
  }
  if (bad.length) {
    console.log(`\n失败样本 ${bad.length} 份（已保存 error）`);
    const kinds = {};
    for (const t of bad) kinds[t.error.split(':')[0]] = (kinds[t.error.split(':')[0]] ?? 0) + 1;
    for (const [k, v] of Object.entries(kinds)) console.log(`  ${k}: ${v}`);
  }
}

function writeDataset(traces, labels) {
  const out = join(traceDir, 'dataset.jsonl');
  const lines = traces
    .filter((t) => t.verdict)
    .map((t) => {
      const l = labels.get(t.recordId);
      return JSON.stringify({
        recordId: t.recordId,
        image: join(traceDir, t.image.file),
        promptVersion: t.promptVersion ?? null,
        prompt: t.prompt,
        task: t.task,
        modelConfig: t.modelConfig,
        aiScore: t.verdict.score,
        confidence: t.verdict.confidence,
        ocrText: t.verdict.ocrText,
        reasons: t.verdict.reasons,
        comment: t.verdict.comment,
        reasoning: t.response?.reasoning ?? '',
        usage: t.response?.usage ?? null,
        latencyMs: t.latencyMs,
        finalScore: l?.finalScore ?? null,
        autoSubmitted: l?.autoSubmitted ?? null,
      });
    });
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\n已写出 ${out}（${lines.length} 条）`);
}

/** 用保存的图片和提示词重新调用模型，评估不同思考强度 */
async function replay(traces, effort, limit) {
  const need = ['MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME'];
  for (const k of need) if (!env[k]) return console.error(`.env 缺少 ${k}，无法 replay`);
  const url = env.MODEL_BASE_URL.replace(/\/+$/, '') + '/chat/completions';
  const maxTokens = Number(env.MODEL_MAX_TOKENS || 80000);
  const timeoutMs = Number(env.MODEL_TIMEOUT_MS || 60000);
  const rows = [];
  const list = traces.filter((t) => t.prompt && t.image?.file && existsSync(join(traceDir, t.image.file))).slice(0, limit || Infinity);
  console.log(`\nreplay: ${list.length} 份，reasoning_effort=${effort}，max_tokens=${maxTokens}`);
  for (const [i, t] of list.entries()) {
    const dataUrl = `data:${t.image.mime || 'image/jpeg'};base64,${readFileSync(join(traceDir, t.image.file)).toString('base64')}`;
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.MODEL_API_KEY}` },
        body: JSON.stringify({
          model: env.MODEL_NAME,
          temperature: Number(env.MODEL_TEMPERATURE || 0.1),
          max_tokens: maxTokens,
          ...(effort === 'off' ? {} : { reasoning_effort: effort }),
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: t.prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = body.choices?.[0]?.message?.content ?? '';
      const reasoning = body.choices?.[0]?.message?.reasoning_content ?? '';
      let score = NaN;
      let parsed = null;
      try {
        const start = content.indexOf('{');
        const end = content.lastIndexOf('}');
        parsed = JSON.parse(content.slice(start, end + 1));
        if (Array.isArray(parsed.points) && parsed.points.length) {
          // 新格式：分数由逐点 delta 汇总（这里不做引用校验，评测只看分数分布）
          score = parsed.points.reduce((s, p) => s + (Number(p.delta) || 0), 0);
        } else {
          score = parsed.score;
        }
      } catch {
        /* 解析失败记 NaN */
      }
      rows.push({
        recordId: t.recordId,
        effort,
        score,
        originalScore: t.verdict?.score ?? null,
        latencyMs: Date.now() - started,
        reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        finishReason: body.choices?.[0]?.finish_reason,
        content,
        ocrText: parsed?.ocr_text ?? null,
        points: parsed?.points ?? null,
        reasons: parsed?.reasons ?? null,
        comment: parsed?.comment ?? null,
        reasoning,
      });
      console.log(`  ${i + 1}/${list.length} #${t.recordId} 分 ${score} ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (e) {
      rows.push({ recordId: t.recordId, effort, error: e.message, latencyMs: Date.now() - started });
      console.log(`  ${i + 1}/${list.length} #${t.recordId} 失败：${e.message}`);
    }
  }
  const out = join(traceDir, `replay-${effort}.jsonl`);
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const okRows = rows.filter((r) => Number.isFinite(r.score));
  const diffs = okRows.filter((r) => Number.isFinite(r.originalScore)).map((r) => r.score - r.originalScore);
  console.log(`\nreplay 结果：${okRows.length}/${rows.length} 成功，${latencyStats(okRows.map((r) => r))}，平均思考 token ${fmt(avg(okRows.map((r) => r.reasoningTokens)), 0)}`);
  if (diffs.length) {
    console.log(`  与原评分相比：完全一致 ${fmt((diffs.filter((d) => d === 0).length / diffs.length) * 100)}%，平均偏差 ${fmt(avg(diffs), 2)} 分`);
  }
  console.log(`已写出 ${out}`);
}

const traces = loadTraces();
summarize(traces);
const labels = loadLabels(traces);
if (args.json) writeDataset(traces, labels);
if (args.replay) {
  const effort = args.replay === true ? 'low' : String(args.replay);
  await replay(traces, effort, Number(args.limit) || Infinity);
}
