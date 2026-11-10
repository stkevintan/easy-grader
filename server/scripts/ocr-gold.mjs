#!/usr/bin/env node
/**
 * C 组实验：在纯转录 OCR 的基础上，带入 production 的 gold 示例（同题人工确认记录，
 * 排除当前卷），每个版本采样 3 次取中位数，和老师最终分比较。
 *
 * 复用 scripts/ocr-compare.mjs 已经跑出的 data/traces/ocr-compare.jsonl（含 newOcr），
 * 不会重新转录，只重新打分。
 *
 * 用法（在 server/ 目录下）：
 *   node scripts/ocr-gold.mjs                  # 全部记录，3 次采样
 *   node scripts/ocr-gold.mjs --limit=5 --samples=1
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { buildPrompt, parseVerdict } = require('../dist/judge/model.service.js');
const { pickGoldExamples } = require('../dist/judge/gold.service.js');

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
const maxExamples = Math.min(10, Math.max(0, Number(env.GOLD_MAX_EXAMPLES) || 4));

for (const k of ['MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME']) {
  if (!env[k]) {
    console.error(`.env 缺少 ${k}`);
    process.exit(1);
  }
}
const apiUrl = env.MODEL_BASE_URL.replace(/\/+$/, '') + '/chat/completions';
const effort = env.MODEL_REASONING_EFFORT;

// ---------- 输入：ocr-compare.jsonl + 任务快照 ----------

const compareFile = join(traceDir, 'ocr-compare.jsonl');
if (!existsSync(compareFile)) {
  console.error('先运行 node scripts/ocr-compare.mjs 生成 data/traces/ocr-compare.jsonl');
  process.exit(1);
}
const items = readFileSync(compareFile, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => r.newOcr && r.bScore != null)
  .slice(0, limit);

let task = null;
for (const f of readdirSync(traceDir)) {
  if (!f.endsWith('.json')) continue;
  try {
    const t = JSON.parse(readFileSync(join(traceDir, f), 'utf8'));
    if (t.task) {
      task = t.task;
      break;
    }
  } catch {
    /* 跳过 */
  }
}
if (!task) {
  console.error('trace 里没有题目快照');
  process.exit(1);
}

// ---------- gold 示例（复刻生产逻辑：同题、人工确认、排除自己） ----------

const db = new Database(dbPath, { readonly: true });
const goldPool = db
  .prepare(
    `SELECT id, finalScore, ocrText FROM judge_records
     WHERE userId = 1 AND taskId = 1 AND status = 'done'
       AND autoSubmitted = 0 AND finalScore IS NOT NULL AND ocrText <> ''
     ORDER BY id DESC LIMIT 300`,
  )
  .all();
db.close();

function examplesFor(recordId) {
  const rows = goldPool.filter((r) => r.id !== recordId);
  return pickGoldExamples(rows, maxExamples);
}

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

async function callModel(prompt) {
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
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
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
    `  ${label.padEnd(24)} n=${pairs.length}  完全一致 ${fmt((pairs.filter((r) => r.score === r.finalScore).length / pairs.length) * 100, 1)}%  ±1分内 ${fmt(
      (abs.filter((x) => x <= 1).length / abs.length) * 100,
      1,
    )}%  MAE ${fmt(avg(abs))}  偏差 ${fmt(avg(diffs))}`,
  );
}

const rows = [];
let done = 0;
for (const item of items) {
  const examples = examplesFor(item.recordId);
  const prompt = buildPrompt(task, examples, item.newOcr);
  const results = await Promise.allSettled(Array.from({ length: sampleCount }, () => callModel(prompt)));
  const verdicts = [];
  const errors = [];
  results.forEach((r) => {
    if (r.status === 'rejected') return errors.push(String(r.reason?.message ?? r.reason));
    try {
      verdicts.push(parseVerdict(r.value, task, env.MODEL_NAME, item.newOcr));
    } catch (e) {
      errors.push(e.message);
    }
  });
  const scores = verdicts.map((v) => v.score);
  const row = {
    recordId: item.recordId,
    finalScore: item.finalScore,
    bScore: item.bScore,
    cScores: scores,
    cScore: scores.length ? median(scores) : null,
    exampleIds: examples.map((e) => `${e.recordId}:${e.score}`),
    cVerified: verdicts.map((v) => (v.points || []).filter((p) => p.verified && p.level !== 'none').length),
    errors,
  };
  rows.push(row);
  done++;
  console.log(
    `  ${done}/${items.length} #${item.recordId} 老师 ${item.finalScore} | B ${item.bScore} | C(gold) ${row.cScore} | 示例 ${row.exampleIds.join(',')}`,
  );
}

const out = join(traceDir, 'ocr-gold.jsonl');
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

console.log('\n===== 与老师最终分比较 =====');
accuracy('A 旧OCR + 新评分', items.map((r) => ({ score: r.aScore, finalScore: r.finalScore })));
accuracy('B 纯转录 + 新评分', items.map((r) => ({ score: r.bScore, finalScore: r.finalScore })));
accuracy('C 纯转录 + gold 示例', rows.filter((r) => r.cScore != null).map((r) => ({ score: r.cScore, finalScore: r.finalScore })));

const paired = rows.filter((r) => r.cScore != null);
const cd = paired.map((r) => r.cScore - r.bScore);
console.log(
  `\nC/B 配对 ${paired.length} 份：分数相同 ${paired.filter((r) => r.cScore === r.bScore).length} 份，平均差 ${fmt(avg(cd))} 分；带示例的平均 ${fmt(avg(rows.map((r) => r.exampleIds.length)), 1)} 条`,
);
if (rows.some((r) => r.errors.length)) console.log(`失败调用 ${rows.reduce((s, r) => s + r.errors.length, 0)} 次`);
console.log(`\n已写出 ${out}`);
