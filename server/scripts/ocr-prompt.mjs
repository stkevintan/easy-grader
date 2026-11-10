#!/usr/bin/env node
/**
 * D 组实验：纯转录 OCR + 当前逐点评分提示词，但追加“评分标准怎么读”的说明：
 *   每个标准点由要点句 + 解释组成，答出要点句指向的措施即算 full；
 *   解释里的举例、效果、措辞不要求出现；只有笼统沾边才 partial。
 *
 * 复用 data/traces/ocr-compare.jsonl 的 newOcr，不重新转录。
 *
 * 用法：node scripts/ocr-prompt.mjs [--samples=3] [--gold]
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
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 6);
const withGold = Boolean(args.gold);
const withExamples = Boolean(args.examples);
const maxExamples = Math.min(10, Math.max(0, Number(env.GOLD_MAX_EXAMPLES) || 4));

for (const k of ['MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME']) {
  if (!env[k]) {
    console.error(`.env 缺少 ${k}`);
    process.exit(1);
  }
}
const apiUrl = env.MODEL_BASE_URL.replace(/\/+$/, '') + '/chat/completions';
const effort = args.effort ? String(args.effort) : env.MODEL_REASONING_EFFORT;
const idFilter = args.ids ? new Set(String(args.ids).split(',').map(Number)) : null;

const compareFile = join(traceDir, 'ocr-compare.jsonl');
if (!existsSync(compareFile)) {
  console.error('先运行 node scripts/ocr-compare.mjs');
  process.exit(1);
}
const items = readFileSync(compareFile, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => !idFilter || idFilter.has(r.recordId));

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

const db = new Database(dbPath, { readonly: true });
const goldPool = withGold
  ? db
      .prepare(
        `SELECT id, finalScore, ocrText FROM judge_records
         WHERE userId = 1 AND taskId = 1 AND status = 'done'
           AND autoSubmitted = 0 AND finalScore IS NOT NULL AND ocrText <> ''
         ORDER BY id DESC LIMIT 300`,
      )
      .all()
  : [];
db.close();

const RUBRIC_READING = `【评分标准的读法】
评分标准的每个点由“要点句”和后面的解释组成。学生答出要点句所指向的措施或方向，即算答出该点，给 full（该点满分）；解释里的具体例子、效果和措辞不要求全部出现，也不能因为学生没写解释就降为 partial。
只有学生表述笼统、与该点方向只是部分沾边，或只说出了其中一半时，才给 partial（该点的一半分）。
同一段作答如果确实同时对应多个不同标准点，可以分别计分；但不要把同一句话拆成多个点重复计分。`;

const EXAMPLES_READING = `评分标准里用“如……”举的典型事例（如杂交水稻研发实践、品种改良、在多个国家推广），是判断该点是否答出的依据之一；学生答到这些事例，同样算答出对应要点，不要因为学生没有复述要点句而判为未答出。`;

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

const EDITED = new Set([308, 310, 312, 321, 324, 326, 328, 331]);

function accuracy(label, pairs) {
  const diffs = pairs.map((p) => p.score - p.finalScore);
  const abs = diffs.map(Math.abs);
  console.log(
    `  ${label.padEnd(34)} n=${pairs.length}  完全一致 ${fmt((pairs.filter((p) => p.score === p.finalScore).length / pairs.length) * 100, 1)}%  ±1分内 ${fmt(
      (abs.filter((x) => x <= 1).length / abs.length) * 100,
      1,
    )}%  MAE ${fmt(avg(abs))}  偏差 ${fmt(avg(diffs))}`,
  );
}

const rows = [];
let done = 0;
for (const item of items) {
  const examples = withGold
    ? pickGoldExamples(goldPool.filter((r) => r.id !== item.recordId), maxExamples)
    : [];
  const prompt =
    buildPrompt(task, examples, item.newOcr) + '\n\n' + RUBRIC_READING + (withExamples ? '\n' + EXAMPLES_READING : '');
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
    cScore: null,
    dScores: scores,
    dScore: scores.length ? median(scores) : null,
    exampleIds: examples.map((e) => `${e.recordId}:${e.score}`),
    errors,
  };
  rows.push(row);
  done++;
  console.log(
    `  ${done}/${items.length} #${item.recordId} 老师 ${item.finalScore} | B ${item.bScore} | D ${row.dScore}${withGold ? ` | 示例 ${row.exampleIds.length}` : ''}${errors.length ? ' [失败:' + errors.length + ']' : ''}`,
  );
}

const out = join(
  traceDir,
  `ocr-prompt${withExamples ? '-examples' : ''}${withGold ? '-gold' : ''}${effort && effort !== env.MODEL_REASONING_EFFORT ? `-${effort}` : ''}.jsonl`,
);
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const ds = rows.filter((r) => r.dScore != null).map((r) => ({ score: r.dScore, finalScore: r.finalScore }));
console.log('\n===== 与老师最终分比较 =====');
accuracy('B 纯转录 + 原评分提示词', items.map((r) => ({ score: r.bScore, finalScore: r.finalScore })));
accuracy(`D 纯转录 + 说明${withExamples ? ' + 事例' : ''}${withGold ? ' + gold' : ''}`, ds);
console.log('\n----- 老师改过分的 8 份（无锚定标签） -----');
accuracy('B', items.filter((r) => EDITED.has(r.recordId)).map((r) => ({ score: r.bScore, finalScore: r.finalScore })));
accuracy(
    `D${withExamples ? ' + 事例' : ''}${withGold ? ' + gold' : ''}`,
    rows.filter((r) => r.dScore != null && EDITED.has(r.recordId)).map((r) => ({ score: r.dScore, finalScore: r.finalScore })),
  );

const paired = rows.filter((r) => r.dScore != null);
console.log(
  `\nD/B 配对 ${paired.length} 份：分数相同 ${paired.filter((r) => r.dScore === r.bScore).length} 份，平均差 ${fmt(avg(paired.map((r) => r.dScore - r.bScore)))} 分`,
);
console.log(`已写出 ${out}`);
