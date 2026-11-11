// 端到端冒烟测试：真实 Chromium + 已构建的扩展 + 本地服务端 + 演示阅卷页。
//
//   pnpm --filter easy-grader-e2e exec playwright install chromium   # 首次
//   pnpm test:e2e            # 在仓库根目录执行：先构建 server 和 extension，再跑本脚本
//
// 覆盖：popup 注册登录 → 打开面板 → 自动识别演示页预设 → 填写题目设置 →
//       获取建议分（mock 模型）→ 写入并提交 → 页面切到下一份 → 服务端记录已确认；
//       打分板页面同样走一遍；管理后台能登录并看到统计。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
// 用开发版：它连本机服务端，并且 manifest 带演示页的内容脚本
const extDir = resolve(process.env.EXT_DIR || join(root, 'extension', 'dist-dev'));
const serverDir = resolve(process.env.SERVER_DIR || join(root, 'server'));
const PORT = 3000; // 扩展默认连 127.0.0.1:3000，演示页 content script 也只匹配本机
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASS = 'e2e-admin-password';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`\n▶ ${s}`);

async function startServer(dataDir) {
  const proc = spawn(process.execPath, ['dist/main.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: join(dataDir, 'app.db'), ADMIN_PASSWORD: ADMIN_PASS, INITIAL_CREDITS: '5', MODEL_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return { proc, log: () => log };
    } catch {}
    await sleep(200);
  }
  proc.kill();
  throw new Error('服务端启动失败：\n' + log);
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'eg-e2e-'));
  const userDir = mkdtempSync(join(tmpdir(), 'eg-chrome-'));
  const server = await startServer(dataDir);
  let ctx;
  try {
    step('启动 Chromium 并加载扩展');
    ctx = await chromium.launchPersistentContext(userDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = new URL(sw.url()).host;
    console.log('  扩展 ID:', extId);

    step('popup：注册账号');
    // 注册需要单元邀请令牌：先用管理员账号建一个测试单元并发一枚
    const adminAuth = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASS }),
    }).then((r) => r.json());
    const unit = await fetch(`${BASE}/api/admin/units`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ name: `e2e-${Date.now()}` }),
    }).then((r) => r.json());
    const invite = await fetch(`${BASE}/api/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ unitId: unit.id, count: 1, credits: 5, expiresAt: new Date(Date.now() + 86400000).toISOString() }),
    }).then((r) => r.json());

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.click('#show-register');
    await popup.fill('#register-username', 'e2e_teacher');
    await popup.fill('#register-password', 'password-123');
    await popup.fill('#invite-token', invite.tokens[0].token);
    await popup.click('#register-form button[type=submit]');
    await popup.waitForSelector('#account:not([hidden])', { timeout: 5000 });
    assert.equal(await popup.textContent('#credits'), '5');
    console.log('  已登录，剩余 5 次');
    await popup.close();

    // ---------- 输入框演示页 ----------
    step('打开演示阅卷页（输入框）并打开面板');
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && console.log('  [page error]', m.text()));
    await page.goto(`${BASE}/demo/index.html`);
    await page.waitForSelector('#answer-canvas');
    await openPanel(ctx, extId, page);

    // 面板在 closed shadow root 里：通过 window.__easyGrader 无法直接访问 DOM，
    // 改用 Playwright 的穿透选择器（对 closed shadow 不生效），所以测试时用 evaluate 驱动面板。
    // 这里直接读取内容脚本暴露的状态，并模拟用户操作。
    await waitView(page, 'task');
    console.log('  已识别演示页预设，进入题目设置');

    step('填写题目设置并保存');
    await panelFill(page, {
      'eg-max': '6',
      'eg-ref': '回忆童年在外婆家的夏天；表达对外婆的思念、对乡村生活的怀念。',
      'eg-rubric': '概括内容 3 分，情感 3 分。',
    });
    await panelClick(page, '保存并开始');
    await waitView(page, 'ready');

    step('获取建议分（mock 模型）');
    await panelClick(page, '获取建议分');
    await waitView(page, 'result', 15000);
    const text = await panelText(page);
    assert.match(text, /置信度/);
    assert.match(text, /mock/);
    console.log('  已拿到建议分');

    step('写入并提交，等待切换到下一份');
    const before = await page.textContent('#progress');
    await panelClick(page, '写入并提交');
    await waitView(page, 'ready', 15000);
    assert.equal(await page.textContent('#progress'), String(Number(before) + 1), '页面应切换到下一份');
    const logLine = await page.textContent('#log');
    assert.match(logLine, /第 1 份：\d+ 分/);
    console.log('  平台日志：', logLine.trim());

    step('同一份题，刷新后能自动续上题目设置');
    await page.reload();
    await page.waitForSelector('#answer-canvas');
    await openPanel(ctx, extId, page);
    await waitView(page, 'ready');
    console.log('  已直接进入阅卷（断点续阅）');

    // ---------- 打分板演示页 ----------
    step('打分板演示页：建议分 → 点分数按钮 → 换卷');
    const p2 = await ctx.newPage();
    await p2.goto(`${BASE}/demo/buttons.html`);
    await p2.waitForSelector('.paper img.answer');
    await openPanel(ctx, extId, p2);
    // 两个演示页的 host + 考试 + 题号相同，会直接续用上面保存的题目设置
    await waitView(p2, 'ready');
    const t2 = await panelText(p2);
    assert.match(t2, /打分板|已载入/);
    const src0 = await p2.getAttribute('.paper img.answer', 'src');
    await panelClick(p2, '获取建议分');
    await waitView(p2, 'result', 15000);
    await panelClick(p2, '写入并提交');
    await waitView(p2, 'ready', 15000);
    assert.notEqual(await p2.getAttribute('.paper img.answer', 'src'), src0, '图片应切换');
    assert.match(await p2.textContent('.log'), /第 1 份：\d+ 分/);
    // 第 1 份与输入框演示页是同一张图，会命中缓存；再阅第 2 份验证新记录
    await panelClick(p2, '获取建议分');
    await waitView(p2, 'result', 15000);
    await panelClick(p2, '写入并提交');
    await waitView(p2, 'ready', 15000);
    assert.match(await p2.textContent('.log'), /第 2 份：\d+ 分/);
    console.log('  打分板流程通过');

    step('服务端：记录已确认、额度已扣');
    const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'e2e_teacher', password: 'password-123' }) })).json();
    const recs = await (await fetch(`${BASE}/api/records`, { headers: { authorization: `Bearer ${login.token}` } })).json();
    assert.equal(recs.total, 2);
    assert.ok(recs.items.every((r) => r.modifiedScore !== null && r.confirmedAt), '两条记录都应已确认');
    assert.equal(login.user.credits, 3);
    console.log('  2 条记录已确认，剩余 3 次');

    step('管理后台：登录并查看概览');
    const admin = await ctx.newPage();
    await admin.goto(`${BASE}/admin/`);
    await admin.fill('#login-user', 'admin');
    await admin.fill('#login-pass', ADMIN_PASS);
    await admin.click('#login-form button[type=submit]');
    await admin.waitForSelector('.stat');
    const stats = await admin.textContent('.grid');
    assert.match(stats, /用户数/);
    await admin.click('a[data-route=records]');
    await admin.waitForSelector('table tbody tr');
    assert.equal(await admin.locator('table tbody tr').count(), 2);
    await admin.click('a[data-route=codes]');
    await admin.click('text=生成兑换码');
    await admin.fill('#f-count', '3');
    await admin.click('#dialog-form button[type=submit]');
    await admin.waitForSelector('#f-codes');
    const codes = (await admin.inputValue('#f-codes')).split('\n');
    assert.equal(codes.length, 3);
    console.log('  管理后台通过，生成兑换码：', codes[0]);

    step('popup：兑换刚生成的码');
    const popup2 = await ctx.newPage();
    await popup2.goto(`chrome-extension://${extId}/popup.html`);
    await popup2.waitForSelector('#account:not([hidden])');
    await popup2.fill('#code', codes[0]);
    await popup2.click('#redeem-form button');
    await popup2.waitForFunction(() => document.querySelector('#redeem-msg')?.textContent.includes('兑换成功'));
    assert.equal(await popup2.textContent('#credits'), '103');
    console.log('  兑换成功，余额 103');

    step('跨域 canvas：insert.js 记录原图地址，内容脚本改由后台下载');
    // 再起一个不同端口的静态服务当“图片 CDN”，页面把它的图画到 canvas 上 → 画布被污染
    const { createServer } = await import('node:http');
    // 图片内容用页面截图生成一张真实 PNG；不带 CORS 头，所以画到 canvas 上会污染画布
    const cdn = createServer(async (_req, res) => {
      const shot = await p2.screenshot({ clip: { x: 0, y: 0, width: 300, height: 150 } });
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(shot);
    });
    await new Promise((r) => cdn.listen(3901, '127.0.0.1', r));
    try {
      const p3 = await ctx.newPage();
      await p3.goto(`${BASE}/demo/index.html`);
      await p3.waitForSelector('#answer-canvas');
      // 用 localhost 访问 3901 端口 → 与 127.0.0.1:3000 不同源
      await p3.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              document.getElementById('answer-canvas').getContext('2d').drawImage(img, 0, 0);
              resolve();
            };
            img.onerror = reject;
            img.src = 'http://localhost:3901/paper.png';
          }),
      );
      const tainted = await p3.evaluate(() => {
        const c = document.getElementById('answer-canvas');
        let blocked = false;
        try {
          c.toDataURL();
        } catch {
          blocked = true;
        }
        return { blocked, src: c.getAttribute('data-eg-src') };
      });
      assert.equal(tainted.blocked, true, '画布应被跨域图片污染');
      assert.equal(tainted.src, 'http://localhost:3901/paper.png', 'insert.js 应记录原图地址');
      await openPanel(ctx, extId, p3);
      await waitView(p3, 'ready');
      await panelClick(p3, '获取建议分');
      await waitView(p3, 'result', 15000);
      console.log('  被污染的画布也能读到答卷');
      await p3.close();
    } finally {
      cdn.close();
    }

    step('扫描件页面（大白底、小手写、换卷时先清空画布）：连续 5 份都能检测到换卷');
    {
      // 回归：旧的指纹只抽 64 个固定位置像素，在大白底答卷上全落空，从第 2~3 份起就检测不到换卷
      const ps = await ctx.newPage();
      await ps.goto(`${BASE}/demo/sparse.html`);
      await ps.waitForSelector('#answer-canvas');
      await openPanel(ctx, extId, ps);
      await waitView(ps, 'ready'); // host+考试+题号与前面相同，直接续用题目设置；/demo/ 前缀命中演示预设
      for (let n = 1; n <= 5; n++) {
        await panelClick(ps, '获取建议分');
        await waitView(ps, 'result', 15000);
        await panelClick(ps, '写入并提交');
        await waitView(ps, 'ready', 15000);
        const text = await panelText(ps);
        assert.match(text, /已切换到下一份/, `第 ${n} 份提交后应检测到换卷，面板：\n${text}`);
        assert.equal(await ps.textContent('#progress'), String(n + 1));
      }
      console.log('  连续 5 份换卷全部检测到');
      await ps.close();
    }

    step('点选适配向导：在没有预设的页面上，用真实鼠标/键盘完成适配');
    {
      // 停用演示页的公共预设，模拟一个“从没适配过”的平台
      const adminLogin = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASS }) })).json();
      const ah = { authorization: `Bearer ${adminLogin.token}`, 'content-type': 'application/json' };
      const presets = await (await fetch(`${BASE}/api/admin/presets`, { headers: ah })).json();
      for (const p of presets.filter((x) => x.hostPattern === '127.0.0.1' && x.pathPattern === '/demo/')) {
        await fetch(`${BASE}/api/admin/presets/${p.id}`, { method: 'PATCH', headers: ah, body: JSON.stringify({ enabled: false }) });
      }

      const p4 = await ctx.newPage();
      await p4.goto(`${BASE}/demo/index.html`);
      await p4.waitForSelector('#answer-canvas');
      await openPanel(ctx, extId, p4);
      await waitView(p4, 'adapt');
      console.log('  没有预设，进入适配向导');

      // 1. 答卷：点向导的「点选」，再在页面上点 canvas
      await panelClickNth(p4, '点选', 0);
      await p4.click('#answer-canvas', { position: { x: 200, y: 100 } });
      await waitText(p4, /已选择答卷（canvas）/);
      // 2. 分数框：点「输入框」，再在平台分数框里真的敲一个数字
      await panelClick(p4, '输入框');
      await sleep(200);
      await p4.click('#score-input');
      await p4.keyboard.type('3');
      await waitText(p4, /已记录分数输入框/);
      await p4.fill('#score-input', '');
      // 3. 提交按钮（点选时会拦截点击，不会真的提交）
      const progressBefore = await p4.textContent('#progress');
      await panelClickNth(p4, '点选', 1);
      await p4.click('#submit-btn');
      await waitText(p4, /已记录提交按钮/);
      assert.equal(await p4.textContent('#progress'), progressBefore, '点选提交按钮时不应真的提交');
      // 4/5. 考试名、题号
      await panelClickNth(p4, '点选', 2);
      await p4.click('#exam-title');
      await waitText(p4, /已记录考试名称/);
      await panelClickNth(p4, '点选', 3);
      await p4.click('#question-no');
      await waitText(p4, /已记录题号/);

      await panelClick(p4, '试读一次');
      await waitText(p4, /读取成功/);
      await panelClick(p4, '保存适配');
      // 考试 + 题号与前面相同，保存后应直接续上题目设置
      await waitView(p4, 'ready');
      await panelClick(p4, '获取建议分');
      await waitView(p4, 'result', 15000);
      await panelClick(p4, '写入并提交');
      await waitView(p4, 'ready', 15000);
      assert.equal(await p4.textContent('#progress'), String(Number(progressBefore) + 1));

      const mine = await (await fetch(`${BASE}/api/adapters/mine`, { headers: { authorization: `Bearer ${login.token}` } })).json();
      assert.equal(mine.length, 1);
      assert.equal(mine[0].config.pics.type, 'canvas');
      console.log('  向导生成的配置：', JSON.stringify({ pics: mine[0].config.pics.selectors, score: mine[0].config.scoreInput.selectors, submit: mine[0].config.submit.selectors }));
      await p4.close();
    }

    console.log('\n✅ 端到端测试全部通过');
  } catch (e) {
    console.error('\n❌ 失败：', e);
    console.error('\n--- 服务端日志 ---\n' + server.log().slice(-3000));
    process.exitCode = 1;
  } finally {
    await ctx?.close().catch(() => {});
    server.proc.kill();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
}

// ---------- 面板驱动 ----------
// 面板是 closed shadow root，页面脚本和 Playwright 都拿不到它的 DOM。
// 内容脚本运行在隔离世界，window.__easyGrader 对页面也不可见。
// 所以测试通过扩展的 service worker 调用 chrome.scripting.executeScript(world: ISOLATED)
// 在内容脚本的世界里驱动面板。为此面板在 window.__easyGrader 上暴露了 _test 钩子。

async function sw(ctx) {
  const [w] = ctx.serviceWorkers();
  return w;
}

/**
 * 在内容脚本的隔离世界里执行一个面板操作。
 * MV3 的扩展 CSP 禁止 eval/new Function，所以不能传任意函数源码，只能按操作名分发。
 */
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
          if (op === 'text') return g._test.text();
          if (op === 'click') return g._test.click(arg);
          if (op === 'clickNth') return g._test.click(arg.label, arg.n);
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

/**
 * 同一个 URL 可能开了多个标签页，按 URL 找会找错。
 * 给每个 Playwright page 打一个唯一的 window.name，再在 service worker 里逐个标签页读出来比对。
 */
const tabIds = new WeakMap();
async function tabIdOf(ctx, page) {
  if (tabIds.has(page)) return tabIds.get(page);
  const mark = `eg-e2e-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((m) => (document.documentElement.dataset.egE2e = m), mark);
  const w = await sw(ctx);
  const id = await w.evaluate(async (mark) => {
    for (const t of await chrome.tabs.query({})) {
      if (!t.id || !/^https?:/.test(t.url ?? '')) continue;
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => document.documentElement.dataset.egE2e });
        if (r?.result === mark) return t.id;
      } catch {}
    }
    return null;
  }, mark);
  if (!id) throw new Error('找不到标签页 ' + page.url());
  tabIds.set(page, id);
  // 页面刷新后 dataset 会丢，但 tabId 不变
  return id;
}

async function openPanel(ctx, extId, page) {
  await page.bringToFront();
  tabIds.delete(page); // 页面可能刚刷新过，重新定位
  const tabId = await tabIdOf(ctx, page);
  const w = await sw(ctx);
  await w.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { cmd: 'panel.toggle' }), tabId);
  void extId;
}

async function waitView(page, view, timeout = 8000) {
  const ctx = page.context();
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await inIsolated(ctx, page, 'status');
    if (last?.view === view) return;
    await sleep(200);
  }
  const text = await panelText(page).catch(() => '');
  throw new Error(`等待面板进入 ${view} 超时，当前 ${JSON.stringify(last)}\n面板内容：${text}`);
}

const panelText = (page) => inIsolated(page.context(), page, 'text');
const panelClick = (page, label) =>
  inIsolated(page.context(), page, 'click', label).then((ok) => {
    if (ok !== true) throw new Error(`面板上找不到按钮「${label}」`);
  });
const panelFill = (page, values) => inIsolated(page.context(), page, 'fill', values);
const panelClickNth = (page, label, n) =>
  inIsolated(page.context(), page, 'clickNth', { label, n }).then((ok) => {
    if (ok !== true) throw new Error(`面板上找不到第 ${n + 1} 个按钮「${label}」`);
  });
async function waitText(page, re, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let t = '';
  while (Date.now() < deadline) {
    t = (await panelText(page)) ?? '';
    if (re.test(t)) return t;
    await sleep(150);
  }
  throw new Error(`等待面板出现 ${re} 超时，当前：\n${t}`);
}

main();
