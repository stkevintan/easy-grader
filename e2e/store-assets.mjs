// 生成 Chrome 应用商店所需的图片：
//   extension/icons/{16,32,48,128}.png   扩展图标（随构建打包）
//   extension/store/icon-128.png         商店图标
//   extension/store/01-result.png        1280×800 截图：评分结果
//   extension/store/02-settings.png      1280×800 截图：题目设置
//   extension/store/03-submitted.png     1280×800 截图：写入并提交后
//
// 截图用的是真实扩展 UI + 本地演示阅卷页 + 本地假模型服务，不包含任何学生数据，
// 也不会调用外部模型。运行前先构建：
//   pnpm --filter easy-grader-server build
//   pnpm --filter easy-grader-extension build:dev
// 然后在仓库根目录：
//   pnpm --filter easy-grader-e2e run store-assets
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const serverDir = join(root, 'server');
const extDir = join(root, 'extension', 'dist-dev');
const iconsDir = join(root, 'extension', 'icons');
const outDir = join(root, 'extension', 'store');
const PORT = 3002;
const MODEL_PORT = 3999;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRANSCRIPT = '作者通过回忆童年在外婆家度过的夏天，表达了对外婆的思念，以及对淳朴乡村生活的怀念。';
const VERDICT = JSON.stringify({
  points: [
    { rubric: '概括内容', level: 'full', delta: 3, quote: '回忆童年在外婆家度过的夏天' },
    { rubric: '情感', level: 'partial', delta: 2, quote: '表达了对外婆的思念' },
  ],
  confidence: 0.86,
  reasons: ['内容概括完整，包含了时间、地点和主要事件', '情感点出了思念外婆，但对乡村生活的怀念表述较弱，给部分分'],
  comment: '内容完整，情感基本准确。',
});

// ---------- 本地假模型：按提示词区分转录 / 评分 ----------
function startFakeModel() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let prompt = '';
      try {
        const j = JSON.parse(body);
        const c = j.messages?.[0]?.content;
        prompt = Array.isArray(c) ? c.map((x) => x?.text ?? '').join('') : String(c ?? '');
      } catch {}
      const content = prompt.includes('逐字转录') ? TRANSCRIPT : VERDICT;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 320, completion_tokens: 180 },
        }),
      );
    });
  });
  return new Promise((ok) => server.listen(MODEL_PORT, '127.0.0.1', () => ok(server)));
}

// ---------- 带演示页和临时数据库的服务端 ----------
async function startAppServer(dataDir) {
  const proc = spawn(process.execPath, ['dist/main.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: join(dataDir, 'app.db'),
      ADMIN_PASSWORD: 'store-assets-only',
      INITIAL_CREDITS: '20',
      ALLOW_REGISTER: 'true',
      SERVE_DEMO: 'true',
      SEED_DEMO_PRESET: 'true',
      MODEL_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`,
      MODEL_API_KEY: 'store-assets',
      MODEL_NAME: 'deepseek-flash',
      MODEL_TIMEOUT_MS: '15000',
      MODEL_SAMPLE_COUNT: '1',
      OCR_TWO_PASS: 'true',
      SCORE_WITH_IMAGE: 'false',
      GOLD_ENABLED: 'false',
      SAVE_TRACES: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return { proc, log: () => log };
    } catch {}
    await sleep(200);
  }
  proc.kill();
  throw new Error('服务端启动失败：\n' + log);
}

// ---------- 面板驱动（复用 e2e/run.mjs 的思路） ----------
async function sw(ctx) {
  const [w] = ctx.serviceWorkers();
  return w ?? (await ctx.waitForEvent('serviceworker', { timeout: 10000 }));
}

const tabIds = new WeakMap();
async function tabIdOf(ctx, page) {
  if (tabIds.has(page)) return tabIds.get(page);
  const mark = `eg-store-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((m) => (document.documentElement.dataset.egStore = m), mark);
  const w = await sw(ctx);
  const id = await w.evaluate(async (mark) => {
    for (const t of await chrome.tabs.query({})) {
      if (!t.id || !/^https?:/.test(t.url ?? '')) continue;
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => document.documentElement.dataset.egStore });
        if (r?.result === mark) return t.id;
      } catch {}
    }
    return null;
  }, mark);
  if (!id) throw new Error('找不到标签页 ' + page.url());
  tabIds.set(page, id);
  return id;
}

async function inIsolated(ctx, page, op, arg = null) {
  const tabId = await tabIdOf(ctx, page);
  const w = await sw(ctx);
  return w.evaluate(
    async ({ tabId, op, arg }) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: (op, arg) => {
          const g = window.__easyGrader;
          if (!g) return { missing: true };
          if (op === 'status') return g.status();
          if (op === 'click') return g._test.click(arg);
          if (op === 'fill') return g._test.fill(arg) ?? true;
          return { unknownOp: op };
        },
        args: [op, arg],
      });
      return r?.result;
    },
    { tabId, op, arg },
  );
}

async function openPanel(ctx, page) {
  await page.bringToFront();
  tabIds.delete(page);
  const tabId = await tabIdOf(ctx, page);
  const w = await sw(ctx);
  await w.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { cmd: 'panel.toggle' }), tabId);
}

async function waitView(page, view, timeout = 10000) {
  const ctx = page.context();
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await inIsolated(ctx, page, 'status');
    if (last?.view === view) return;
    await sleep(200);
  }
  throw new Error(`等待面板进入 ${view} 超时，当前 ${JSON.stringify(last)}`);
}

const panelClick = (page, label) =>
  inIsolated(page.context(), page, 'click', label).then((ok) => {
    if (ok !== true) throw new Error(`面板上找不到按钮「${label}」`);
  });
const panelFill = (page, values) => inIsolated(page.context(), page, 'fill', values);

// ---------- 图标 ----------
async function renderIcons(browser) {
  const svg = readFileSync(join(iconsDir, 'icon.svg'), 'utf8');
  const smallSvg = readFileSync(join(iconsDir, 'icon-small.svg'), 'utf8');
  for (const size of [16, 32, 48, 128]) {
    // 16/32 用只有对勾的简化版，工具栏上更清楚；48/128 保留文档细节
    const source = size <= 32 ? smallSvg : svg;
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
    );
    await page.screenshot({ path: join(iconsDir, `${size}.png`), omitBackground: true });
    await page.close();
    console.log(`  图标 ${size}×${size}`);
  }
  mkdirSync(outDir, { recursive: true });
  await (async () => {
    const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:128px;height:128px}</style>${svg}`);
    await page.screenshot({ path: join(outDir, 'icon-128.png'), omitBackground: true });
    await page.close();
  })();
  console.log('  商店图标 icon-128.png');
}

// ---------- 主流程 ----------
const dataDir = mkdtempSync(join(tmpdir(), 'eg-store-data-'));
const userDir = mkdtempSync(join(tmpdir(), 'eg-store-chrome-'));
let fake;
let app;
let ctx;
try {
  mkdirSync(outDir, { recursive: true });
  console.log('▶ 生成图标');
  const iconBrowser = await chromium.launch({ channel: 'chromium', headless: true });
  await renderIcons(iconBrowser);
  await iconBrowser.close();
  // 图标刚生成，同步到已构建的开发版里，保证加载的扩展 manifest 引用的图标都存在
  cpSync(iconsDir, join(extDir, 'icons'), { recursive: true });

  console.log('▶ 启动假模型和本地服务端');
  fake = await startFakeModel();
  app = await startAppServer(dataDir);

  console.log('▶ 启动 Chromium 并加载开发版扩展');
  ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const worker = await sw(ctx);
  const extId = new URL(worker.url()).host;

  console.log('▶ 设置服务端地址并注册演示账号');
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click('#toggle-settings');
  await popup.fill('#server-url', `http://127.0.0.1:${PORT}`);
  await popup.click('#save-settings');
  await popup.waitForFunction(() => /已保存/.test(document.querySelector('#settings-msg')?.textContent ?? ''), null, { timeout: 5000 });
  await popup.fill('#username', '王老师');
  await popup.fill('#password', 'password-123');
  await popup.click('#register-btn');
  await popup.waitForSelector('#account:not([hidden])', { timeout: 8000 });
  await popup.close();

  console.log('▶ 打开演示阅卷页');
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${PORT}/demo/index.html`);
  await page.waitForSelector('#answer-canvas');
  await openPanel(ctx, page);
  await waitView(page, 'task');

  await panelFill(page, {
    'eg-exam': '高二语文期中考试',
    'eg-max': '6',
    'eg-ref': '回忆童年在外婆家的夏天；表达对外婆的思念、对乡村生活的怀念。',
    'eg-rubric': '概括内容 3 分，情感 3 分。',
  });
  await page.mouse.click(200, 20); // 点页面空白处，去掉输入框焦点
  await page.screenshot({ path: join(outDir, '02-settings.png') });
  console.log('  02-settings.png');

  await panelClick(page, '保存并开始');
  await waitView(page, 'ready');
  await panelClick(page, '获取建议分');
  await waitView(page, 'result');
  await page.mouse.click(200, 20);
  await page.screenshot({ path: join(outDir, '01-result.png') });
  console.log('  01-result.png');

  await panelClick(page, '写入并提交');
  await waitView(page, 'ready');
  await page.waitForFunction(() => /第 1 份/.test(document.querySelector('#log')?.textContent ?? ''), null, { timeout: 10000 });
  await page.mouse.click(200, 20);
  await page.screenshot({ path: join(outDir, '03-submitted.png') });
  console.log('  03-submitted.png');

  console.log(`\n完成：${outDir}`);
} finally {
  await ctx?.close().catch(() => {});
  app?.proc.kill();
  fake?.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
}
