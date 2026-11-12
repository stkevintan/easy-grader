// 面板交互：阅卷模式切换、全自动间隔不能再开第二个循环、结果页快捷键。
// 用 esbuild 把 Preact 组件和 controller 打包后在 jsdom 里渲染。
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const entry = `
  import { h, render } from 'preact';
  import { PanelApp } from './src/content/panel/PanelApp';
  import * as store from './src/content/panel/store';
  import * as controller from './src/content/panel/controller';
  window.__p = { h, render, PanelApp, store, controller };
`;

const { outputFiles } = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { chrome: 'globalThis.__chrome', __DEV__: 'true', __SERVER_URL__: '"http://127.0.0.1:3000"' },
});
const code = outputFiles[0].text;

const task = {
  taskId: 't1', scoreStep: 1,
  exam: { exam: '期中', subject: '语文', q_index: '1' },
  question: { content: { score: 6 } },
};
const result = {
  gradingId: 'g1', score: 4, maxScore: 6, confidence: 0.5, reasons: ['要点一'], reason: '', comment: '',
  model: 'x', cached: false, balance: 9,
};

async function setup() {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/demo/' });
  const w = dom.window;
  w.__chrome = { runtime: { sendMessage: async () => ({ ok: true, data: {} }) } };
  w.eval(code);
  const p = w.__p;
  p.store.settings.value = { serverUrl: '', autoMinConfidence: 0.7, autoIntervalMs: 2500 };
  const app = w.document.getElementById('app');
  p.render(p.h(p.PanelApp, null), app);
  const flush = () => new Promise((r) => w.setTimeout(r, 20));
  const buttons = () => Array.from(app.querySelectorAll('button')).map((b) => b.textContent.trim());
  const click = (label) => {
    const b = Array.from(app.querySelectorAll('button')).find((x) => x.textContent.trim() === label);
    assert.ok(b, `找不到按钮「${label}」，当前：${buttons().join(' | ')}`);
    b.click();
  };
  return { w, p, app, flush, buttons, click };
}

test('模式切换条常驻，默认手动；开启全自动先在面板内确认', async () => {
  const { p, flush, buttons, click, app } = await setup();
  p.store.state.value = { view: 'ready', task };
  await flush();
  assert.deepEqual(buttons().slice(0, 3), ['手动', '半自动', '全自动']);
  assert.equal(p.store.mode.value, 'manual');
  assert.ok(buttons().includes('获取建议分'));

  click('半自动');
  await flush();
  assert.equal(p.store.mode.value, 'semi');
  assert.match(app.textContent, /半自动：换到新答卷自动出建议分/);

  click('全自动');
  await flush();
  assert.equal(p.store.mode.value, 'semi', '确认前不切换');
  assert.ok(buttons().includes('确认开启'));
  click('先不开');
  await flush();
  assert.ok(!buttons().includes('确认开启'));
});

test('全自动两份之间（isAuto 且 ready）：只有「停止自动阅卷」，没有能再开循环的按钮', async () => {
  const { p, flush, buttons, click } = await setup();
  p.store.mode.value = 'auto';
  p.controller.isAuto.value = true;
  p.store.state.value = { view: 'ready', task };
  await flush();
  const b = buttons();
  assert.ok(b.includes('停止自动阅卷'));
  assert.ok(!b.includes('获取建议分'));
  assert.ok(!b.includes('继续自动阅卷'));
  // 循环已在跑时 runAuto 直接返回，不会启动第二个
  await p.controller.runAuto();
  assert.equal(p.controller.isAuto.value, true);

  click('停止自动阅卷');
  await flush();
  assert.equal(p.store.mode.value, 'manual');
  assert.equal(p.controller.isAuto.value, false);
  assert.ok(buttons().includes('获取建议分'));
});

test('结果页切到全自动：暂停在这一份，主按钮变成「确认并继续自动」，可随时切回手动', async () => {
  const { p, flush, buttons, click } = await setup();
  p.store.state.value = { view: 'result', task, result };
  await flush();
  click('全自动');
  await flush();
  click('确认开启');
  await flush();
  assert.equal(p.store.mode.value, 'auto');
  assert.equal(p.store.autoPaused.value, true);
  assert.ok(buttons().includes('确认并继续自动'));

  click('手动');
  await flush();
  assert.equal(p.store.mode.value, 'manual');
  assert.ok(buttons().includes('写入并提交'));

  // 本页面确认过一次，再开启不再询问
  click('全自动');
  await flush();
  assert.equal(p.store.mode.value, 'auto');
  assert.ok(!buttons().includes('确认开启'));
});

test('评分中：手动模式按钮是「不看这次结果」并注明仍扣次数；全自动时是停止', async () => {
  const { p, flush, buttons, app } = await setup();
  p.store.state.value = { view: 'judging', task, auto: false };
  await flush();
  assert.ok(buttons().includes('不看这次结果'));
  assert.match(app.textContent, /也会扣次数/);
  p.controller.isAuto.value = true;
  await flush();
  assert.ok(buttons().includes('停止自动阅卷'));
});

test('结果页快捷键：Esc 放弃回到就绪；Enter 在分数非法时提示错误', async () => {
  const { w, p, flush, app } = await setup();
  p.store.state.value = { view: 'result', task, result };
  await flush();
  const input = app.querySelector('input[type=number]');
  input.value = '99';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  await flush();
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.equal(p.store.notice.value?.kind, 'error');
  assert.equal(p.store.state.value.view, 'result');

  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  assert.equal(p.store.state.value.view, 'ready');
});

test('半自动轮询只在半自动模式下触发', async () => {
  const { p, flush } = await setup();
  p.store.preset.value = { config: { pics: {}, questionNo: {} } };
  p.store.state.value = { view: 'ready', task };
  await flush();
  p.controller.maybeAutoJudge();
  assert.equal(p.store.judgeCandidate.value, null, '手动模式下不应记录换卷候选');
});

test('有提交正在进行时，结果页按钮禁用、Enter 不会再提交一次', async () => {
  const { w, p, flush, app } = await setup();
  p.store.state.value = { view: 'result', task, result };
  p.store.committing.value = true;
  await flush();
  const primary = Array.from(app.querySelectorAll('button')).find((b) => b.textContent.trim() === '写入并提交');
  assert.equal(primary.disabled, true);
  assert.equal(await p.controller.commitScore(4, true, false), false, '并发的第二次提交直接拒绝');
  app.querySelector('input[type=number]').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  assert.equal(p.store.state.value.view, 'result', '提交中 Esc 不放弃');
});

test('全自动已暂停后等待换卷：停止按钮会退出全自动', async () => {
  const { p, flush, click } = await setup();
  p.store.mode.value = 'auto';
  p.store.state.value = { view: 'waiting', task, auto: false };
  await flush();
  click('停止自动阅卷');
  await flush();
  assert.equal(p.store.mode.value, 'manual');
  assert.equal(p.store.state.value.view, 'ready');
});
