#!/usr/bin/env node
/**
 * OCR 对照实验：同一张答卷图片，
 *   A：旧版单阶段 OCR（评分提示词里带评分标准，结果已存在 trace.verdict.ocrText）
 *   B：新版纯转录 OCR（提示词不含题目/参考答案/评分标准）
 * 然后分别用当前逐点评分提示词（不带图）打分 3 次取中位数，和老师最终分比较。
 *
 * 用法（在 server/ 目录下）：
 *   node scripts/ocr-compare.mjs                 # 默认取所有人工确认且有 trace 的记录
 *   node scripts/ocr-compare.mjs --limit=5       # 先小样本试跑
 *   node scripts/ocr-compare.mjs --samples=1     # 每个版本只打 1 次分（更省额度）
 *
 * 会真实调用模型、消耗额度，并且会把答卷图片发给 .env 里配置的模型服务商。
 * 结果写到 data/traces/ocr-compare.jsonl。
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { buildOcrPrompt, buildPrompt, parseVerdict } = require('../dist/judge/model.service.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
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
const traceDir = resolve(env.TRACE_DIR || 'data/traces');
const dbPath = resolve(env.DB_PATH || 'data/app.db');
const sampleCount = Math.max(1, Number(args.samples) || 3);
const limit = Number(args.limit) || Infinity;
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 6);

for (const k of ['MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME']) {
  if (!env[k]) {
    console.error(`.env 缺少 ${k}`);
    process.exit(1);
  }
}
const apiUrl = env.MODEL_BASE_URL.replace(/\/+$/, '') + '/chat/completions';
const effort = env.MODEL_REASONING_EFFORT;

// ---------- 读取 gold 集 ----------

const db = new Database(dbPath, { readonly: true });
const records = db
  .prepare(
    `SELECT id, finalScore, aiScore FROM judge_records
     WHERE confirmedAt IS NOT NULL AND autoSubmitted = 0 AND finalScore IS NOT NULL
     ORDER BY id`,
  )
  .all();
db.close();

const traces = new Map();
for (const f of readdirSync(traceDir)) {
  if (!f.endsWith('.json')) continue;
  try {
    const t = JSON.parse(readFileSync(join(traceDir, f), 'utf8'));
    if (t.recordId && t.image?.file && t.verdict) traces.set(t.recordId, { ...t, file: join(traceDir, f) });
  } catch {
    /* 跳过损坏文件 */
  }
}

const items = records
  .filter((r) => traces.has(r.id))
  .map((r) => ({ ...r, trace: traces.get(r.id) }))
  .filter((r) => existsSync(join(traceDir, r.trace.image.file)))
  .slice(0, limit);

if (!items.length) {
  console.error('没有找到「人工确认 + trace + 图片」的记录');
  process.exit(1);
}
console.log(
  `gold 集 ${items.length} 份（最终分分布：${JSON.stringify(
    items.reduce((m, r) => ((m[r.finalScore] = (m[r.finalScore] || 0) + 1), m), {}),
  )}）；每个版本采样 ${sampleCount} 次\n`,
);

// ---------- 模型调用 ----------

let inflight = 0;
const waiting = [];
async function gate() {
  if (inflight < CONCURRENCY) {
    inflight++;
    return;
  }
  await new Promise((r) => waiting.push(r));
  inflight++;
}
function release() {
  inflight--;
  const next = waiting.shift();
  if (next) next();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModel(prompt, imageDataUrl) {
  await gate();
  try {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.MODEL_API_KEY}` },
          body: JSON.stringify({
            model: env.MODEL_NAME,
            temperature: Number(env.MODEL_TEMPERATURE || 0.1),
            max_tokens: Number(env.MODEL_MAX_TOKENS || 80000),
            ...(effort ? { reasoning_effort: effort } : {}),
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
          signal: AbortSignal.timeout(Number(env.MODEL_TIMEOUT_MS || 60000)),
        });
      } catch (e) {
        if (attempt >= 2) throw e;
        await sleep(800 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await sleep(800 * 2 ** attempt);
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      }
      const body = await res.json();
      return body.choices?.[0]?.message?.content ?? '';
    }
  } finally {
    release();
  }
}

// ---------- 工具 ----------

const norm = (s) =>
  (s || '')
    .replace(/4\s*[（(]\s*6\s*分\s*[）)]/g, '')
    .replace(/[\s，。、；：""''“”‘’（）()【】[\]「」…—\-·0-9①-⑩]/g, '');

function lev(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
const similarity = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  const L = Math.max(x.length, y.length);
  return L ? 1 - lev(x, y) / L : 1;
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '-');

function accuracy(label, rows) {
  const pairs = rows.filter((r) => Number.isFinite(r.score));
  const diffs = pairs.map((r) => r.score - r.finalScore);
  const abs = diffs.map(Math.abs);
  console.log(
    `  ${label.padEnd(22)} n=${pairs.length}  完全一致 ${fmt((pairs.filter((r) => r.score === r.finalScore).length / pairs.length) * 100, 1)}%  ±1分内 ${fmt(
      (abs.filter((x) => x <= 1).length / abs.length) * 100,
      1,
    )}%  MAE ${fmt(avg(abs))}  偏差 ${fmt(avg(diffs))}`,
  );
}

// ---------- 跑实验 ----------

async function scoreVariant(task, transcript) {
  if (!transcript.trim()) return { scores: [], verdicts: [], errors: ['空转录'] };
  const prompt = buildPrompt(task, [], transcript);
  const results = await Promise.allSettled(
    Array.from({ length: sampleCount }, () => callModel(prompt, undefined)),
  );
  const verdicts = [];
  const errors = [];
  results.forEach((r) => {
    if (r.status === 'rejected') return errors.push(String(r.reason?.message ?? r.reason));
    try {
      verdicts.push(parseVerdict(r.value, task, env.MODEL_NAME, transcript));
    } catch (e) {
      errors.push(e.message);
    }
  });
  return { scores: verdicts.map((v) => v.score), verdicts, errors };
}

const rows = [];
let done = 0;
for (const item of items) {
  const t = item.trace;
  const task = t.task;
  const image = `data:${t.image.mime || 'image/jpeg'};base64,${readFileSync(join(traceDir, t.image.file)).toString('base64')}`;
  const oldOcr = t.verdict.ocrText || '';

  let newOcr = '';
  let ocrError = '';
  try {
    newOcr = (await callModel(buildOcrPrompt(), image)).trim().slice(0, 4000);
  } catch (e) {
    ocrError = e.message;
  }

  const [a, b] = await Promise.all([scoreVariant(task, oldOcr), scoreVariant(task, newOcr)]);
  const row = {
    recordId: item.id,
    finalScore: item.finalScore,
    oldScore: t.verdict.score,
    oldAiScore: item.aiScore,
    oldOcr,
    newOcr,
    ocrError,
    ocrSimilarity: newOcr ? similarity(oldOcr, newOcr) : null,
    oldOcrBoxes: (oldOcr.match(/□/g) || []).length,
    newOcrBoxes: (newOcr.match(/□/g) || []).length,
    aScores: a.scores,
    bScores: b.scores,
    aScore: a.scores.length ? median(a.scores) : null,
    bScore: b.scores.length ? median(b.scores) : null,
    aVerified: a.verdicts.map((v) => (v.points || []).filter((p) => p.verified && p.level !== 'none').length),
    bVerified: b.verdicts.map((v) => (v.points || []).filter((p) => p.verified && p.level !== 'none').length),
    aErrors: a.errors,
    bErrors: b.errors,
  };
  rows.push(row);
  done++;
  const diff = row.aScore != null && row.bScore != null ? row.bScore - row.aScore : NaN;
  console.log(
    `  ${done}/${items.length} #${item.id} 老师 ${item.finalScore} | 旧OCR ${row.aScore} | 纯转录 ${row.bScore} | OCR相似 ${fmt(row.ocrSimilarity)}` +
      (Number.isFinite(diff) && diff !== 0 ? `  <- 分差 ${diff}` : '') +
      (ocrError ? `  [OCR失败: ${ocrError}]` : ''),
  );
}

const out = join(traceDir, 'ocr-compare.jsonl');
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

console.log('\n===== 与老师最终分比较 =====');
accuracy('旧版单阶段（原始记录）', items.map((r) => ({ score: r.trace.verdict.score, finalScore: r.finalScore })));
accuracy('A 旧OCR + 新评分', rows.filter((r) => r.aScore != null).map((r) => ({ score: r.aScore, finalScore: r.finalScore })));
accuracy('B 纯转录 + 新评分', rows.filter((r) => r.bScore != null).map((r) => ({ score: r.bScore, finalScore: r.finalScore })));

const paired = rows.filter((r) => r.aScore != null && r.bScore != null);
const bd = paired.map((r) => r.bScore - r.aScore);
console.log(
  `\nA/B 配对 ${paired.length} 份：中位数相同 ${paired.filter((r) => r.bScore === r.aScore).length} 份，平均差 ${fmt(avg(bd))} 分`,
);
const sims = rows.map((r) => r.ocrSimilarity).filter(Number.isFinite);
console.log(
  `OCR 文本：旧/新相似度 avg ${fmt(avg(sims), 3)}；□ 数量 avg 旧 ${fmt(avg(rows.map((r) => r.oldOcrBoxes)), 1)} / 新 ${fmt(
    avg(rows.map((r) => r.newOcrBoxes)),
    1,
  )}`,
);
console.log(`\n已写出 ${out}`);
