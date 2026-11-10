// 用 jsdom 测内容脚本的 DOM 逻辑：选择器生成、写分、打分板匹配、提交与换卷检测。
// 先用 esbuild 把 TS 源码打成一个可在 jsdom window 里执行的 bundle。
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const entry = `
  import * as dom from './src/content/dom';
  import * as adapter from './src/content/adapter';
  import * as wizard from './src/content/wizard';
  window.__t = { dom, adapter, wizard };
`;

const { outputFiles } = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' },
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2022',
  // 测试里没有 chrome.runtime：capture.ts 用到的 bg() 不会被调用
  define: { chrome: 'globalThis.__chrome', __DEV__: 'true', __SERVER_URL__: '"http://127.0.0.1:3000"' },
});
const code = outputFiles[0].text;

function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/demo/' });
  const w = dom.window;
  // jsdom 没有布局：让所有元素都“可见”且有尺寸
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON() {} };
  };
  w.eval(code);
  return { w, doc: w.document, t: w.__t };
}

const baseCfg = (over = {}) => ({
  version: 1,
  pics: { selectors: ['img.answer'], type: 'img', multiple: false },
  scoreMode: 'input',
  scoreInput: { selectors: ['#score'] },
  scoreButtons: { selectors: [], clickType: 'click' },
  submit: { selectors: ['#submit'], clickType: 'click' },
  confirm: { selectors: [] },
  examTitle: { selectors: ['.exam'] },
  questionNo: { selectors: ['.qno'] },
  maxScore: { selectors: ['.full'], regex: '(\\d+(?:\\.\\d+)?)' },
  nextTimeoutMs: 1000,
  submitDelayMs: 0,
  ...over,
});

test('uniqueSelector：优先 id，其次稳定属性/class，跳过自动生成的 class', () => {
  const { doc, t } = page(`
    <div class="wrap"><input id="score" /></div>
    <div class="panel-a1b2c3d4"><input name="mark" /></div>
    <ul class="list"><li><button class="btn">1</button></li><li><button class="btn">2</button></li></ul>
    <div class="x"><span>a</span><span>b</span></div>
  `);
  assert.equal(t.dom.uniqueSelector(doc.querySelector('#score')), '#score');
  assert.equal(t.dom.uniqueSelector(doc.querySelector('[name=mark]')), 'input[name="mark"]');
  for (const el of doc.querySelectorAll('button, span')) {
    const sel = t.dom.uniqueSelector(el);
    assert.equal(doc.querySelectorAll(sel).length, 1, sel);
    assert.equal(doc.querySelector(sel), el, sel);
    assert.ok(!sel.includes('a1b2c3d4'), `不应使用自动生成的 class: ${sel}`);
  }
});

test('groupSelector：点一个分数按钮，命中整组', () => {
  const { doc, t } = page(`<div class="board">${[0, 1, 2, 3].map((n) => `<button class="s">${n}</button>`).join('')}</div><button class="s">提交</button>`);
  const sel = t.dom.groupSelector(doc.querySelectorAll('.board .s')[2]);
  assert.equal(doc.querySelectorAll(sel).length, 4, sel);
});

test('queryAll 跳过非法选择器并按顺序回退', () => {
  const { doc, t } = page(`<p class="b">x</p>`);
  assert.equal(t.dom.queryAll(['::bad((', '.a', '.b']).length, 1);
  assert.equal(t.dom.queryOne(['.none']), null);
  void doc;
});

test('setInputValue 触发 input/change，并走原生 setter（兼容受控组件）', () => {
  const { doc, t, w } = page(`<input id="s" />`);
  const el = doc.getElementById('s');
  const seen = [];
  el.addEventListener('input', () => seen.push('input:' + el.value));
  el.addEventListener('change', () => seen.push('change'));
  // 模拟 React：实例上覆盖了 value 属性
  let tracked = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() {
      return w.HTMLInputElement.prototype.__lookupGetter__('value').call(this);
    },
    set(v) {
      tracked = 'instance:' + v;
    },
  });
  t.dom.setInputValue(el, '5');
  assert.deepEqual(seen, ['input:5', 'change']);
  assert.equal(tracked, '', '应绕过实例 setter，直接调用原型 setter');
});

test('readPaperInfo：选择器、正则、固定值', () => {
  const { t } = page(`<span class="exam">  期中 语文 </span><span class="qno">第17题</span><span class="full">满分 6 分</span>`);
  // 对象来自 jsdom 的 realm，原型不同，展开成普通对象再比较
  assert.deepEqual({ ...t.adapter.readPaperInfo(baseCfg()) }, { examTitle: '期中 语文', questionNo: '第17题', maxScore: 6 });
  const cfg = baseCfg({ examTitle: { selectors: ['.exam'], fixed: '手填考试' }, questionNo: { selectors: ['.qno'], regex: '(\\d+)' } });
  assert.deepEqual({ ...t.adapter.readPaperInfo(cfg) }, { examTitle: '手填考试', questionNo: '17', maxScore: 6 });
});

test('setScore 输入框：写入并通过 verifyScore；多个/零个输入框时报错', () => {
  const { doc, t } = page(`<input id="score" />`);
  t.adapter.setScore(baseCfg(), 4.5, 6);
  assert.equal(doc.getElementById('score').value, '4.5');
  assert.equal(t.adapter.verifyScore(baseCfg(), 4.5), true);
  assert.equal(t.adapter.verifyScore(baseCfg(), 4), false);

  const two = page(`<input class="s" /><input class="s" />`);
  assert.throws(() => two.t.adapter.setScore(baseCfg({ scoreInput: { selectors: ['.s'] } }), 1, 6), /多个分数输入框/);
  const none = page(``);
  assert.throws(() => none.t.adapter.setScore(baseCfg(), 1, 6), /找不到分数输入框/);
  const ro = page(`<input id="score" readonly />`);
  assert.throws(() => ro.t.adapter.setScore(baseCfg(), 1, 6), /不可编辑/);
});

test('setScore / verifyScore 用同一个可见输入框，不会读到隐藏框', () => {
  const { doc, t } = page(`<input type="text" style="display:none" /><input id="score" type="text" />`);
  const cfg = baseCfg({ scoreInput: { selectors: ['input[type="text"]'] } });
  t.adapter.setScore(cfg, 3, 6);
  assert.equal(doc.getElementById('score').value, '3');
  assert.equal(t.adapter.verifyScore(cfg, 3), true);
});

test('typeScore：execCommand 不可用时用逐字符事件写入', async () => {
  const { doc, t } = page(`<input id="score" />`);
  await t.adapter.typeScore(baseCfg(), 4.5);
  assert.equal(doc.getElementById('score').value, '4.5');
  assert.equal(t.adapter.verifyScore(baseCfg(), 4.5), true);
});

test('rejectText / waitRejectChange：识别平台「分数不能为空」提示', async () => {
  const { doc, t } = page(`<div id="err"></div>`);
  assert.equal(t.adapter.rejectText(), null);
  const waiting = t.adapter.waitRejectChange(null, 800);
  setTimeout(() => (doc.getElementById('err').textContent = '分数不能为空'), 100);
  assert.equal(await waiting, '分数不能为空');
});

test('setScore 打分板：按文字匹配“3”“3分”“满分”', () => {
  const { doc, t } = page(`<div class="b"><button>0</button><button>1.5</button><button>3分</button><button>满分</button></div>`);
  const clicked = [];
  doc.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => clicked.push(b.textContent)));
  const cfg = baseCfg({ scoreMode: 'buttons', scoreInput: { selectors: [] }, scoreButtons: { selectors: ['.b button'], clickType: 'click' } });
  t.adapter.setScore(cfg, 3, 6);
  t.adapter.setScore(cfg, 1.5, 6);
  t.adapter.setScore(cfg, 6, 6);
  assert.deepEqual(clicked, ['3分', '1.5', '满分']);
  assert.throws(() => t.adapter.setScore(cfg, 2, 6), /找不到「2」分/);
});

/** jsdom 不会真正加载图片：手动控制 currentSrc / complete / naturalWidth */
function fakeImg(img, { loaded = true } = {}) {
  const state = { loaded };
  Object.defineProperty(img, 'currentSrc', { get: () => img.getAttribute('src') });
  Object.defineProperty(img, 'complete', { get: () => state.loaded });
  Object.defineProperty(img, 'naturalWidth', { get: () => (state.loaded ? 800 : 0) });
  Object.defineProperty(img, 'naturalHeight', { get: () => (state.loaded ? 600 : 0) });
  return state;
}

test('submit + waitForNext：点提交后图片地址变化即视为换卷；不变则超时返回 false', async () => {
  const { doc, t } = page(`<img class="answer" src="http://localhost/a.png" /><button id="submit">提交</button>`);
  const img = doc.querySelector('img');
  fakeImg(img);
  doc.getElementById('submit').addEventListener('click', () => setTimeout(() => img.setAttribute('src', 'http://localhost/b.png'), 300));
  const cfg = baseCfg();
  const before = t.adapter.fingerprintParts(cfg);
  // jsdom 没有 canvas，读不到像素，退回只比地址
  assert.deepEqual([...before], ['http://localhost/a.png']);
  await t.adapter.submit(cfg);
  assert.equal(await t.adapter.waitForNext(cfg, before), true);

  const still = t.adapter.fingerprintParts(cfg);
  assert.equal(await t.adapter.waitForNext({ ...cfg, nextTimeoutMs: 500 }, still), false);
});

test('waitForNext：新图还在加载时不算换卷，加载完成后才算', async () => {
  const { doc, t } = page(`<img class="answer" src="http://localhost/a.png" />`);
  const img = doc.querySelector('img');
  const state = fakeImg(img);
  const cfg = baseCfg({ nextTimeoutMs: 3000 });
  const before = t.adapter.fingerprintParts(cfg);
  // 换地址但图片还没加载完 → 指纹带 #loading，属于过渡状态
  state.loaded = false;
  img.setAttribute('src', 'http://localhost/b.png');
  assert.match(t.adapter.fingerprint(cfg), /#loading$/);
  let settled = false;
  const waiting = t.adapter.waitForNext(cfg, before).then((v) => ((settled = true), v));
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(settled, false, '加载中不应判定为已换卷');
  state.loaded = true;
  assert.equal(await waiting, true);
});

test('changeState：多张答卷图逐张判断', () => {
  const { t } = page('');
  const cs = (a, b) => t.adapter.changeState(a, b);
  assert.equal(cs(['a1', 'a2'], ['b1', 'b2']), 'full');
  assert.equal(cs(['a1', 'a2'], ['b1', 'a2']), 'partial', '只换了第一张');
  assert.equal(cs(['a1', 'a2'], ['a1', 'a2']), 'none');
  assert.equal(cs(['a1', 'a2'], ['b1', 'x#loading']), 'none', '第二张还在加载');
  assert.equal(cs(['a1', 'a2'], ['b1']), 'full', '这份学生只有一页');
  assert.equal(cs(['a1', 'a2'], []), 'none', '答卷区域暂时消失');
  assert.equal(cs(['a1'], ['blank#loading']), 'none', '画布被清空');
});

test('waitForNext：多张图逐张加载时，等最后一张也换掉才算换卷', async () => {
  const { doc, t } = page(`<div><img class="answer" src="http://localhost/a1.png" /><img class="answer" src="http://localhost/a2.png" /></div>`);
  const [i1, i2] = doc.querySelectorAll('img');
  fakeImg(i1);
  fakeImg(i2);
  const cfg = baseCfg({ pics: { selectors: ['img.answer'], type: 'img', multiple: true }, nextTimeoutMs: 4000 });
  const before = t.adapter.fingerprintParts(cfg);
  assert.equal(before.length, 2);
  let settled = false;
  const waiting = t.adapter.waitForNext(cfg, before).then((v) => ((settled = true), v));
  i1.setAttribute('src', 'http://localhost/b1.png'); // 先换第一张
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(settled, false, '只换了第一张时不应判定为已换卷');
  i2.setAttribute('src', 'http://localhost/b2.png'); // 第二张也换了
  const t0 = Date.now();
  assert.equal(await waiting, true);
  assert.ok(Date.now() - t0 < 1000, '全部换完后应很快判定');
});

test('waitForNext：两份答卷有一页恰好相同（如空白页），等待一段时间后仍接受', async () => {
  const { doc, t } = page(`<div><img class="answer" src="http://localhost/a1.png" /><img class="answer" src="http://localhost/blank.png" /></div>`);
  const [i1, i2] = doc.querySelectorAll('img');
  fakeImg(i1);
  fakeImg(i2);
  const cfg = baseCfg({ pics: { selectors: ['img.answer'], type: 'img', multiple: true }, nextTimeoutMs: 5000 });
  const before = t.adapter.fingerprintParts(cfg);
  i1.setAttribute('src', 'http://localhost/b1.png'); // 第二页仍是同一张空白页
  const t0 = Date.now();
  assert.equal(await t.adapter.waitForNext(cfg, before), true);
  const ms = Date.now() - t0;
  assert.ok(ms >= 2000 && ms < 3500, `部分变化需稳定约 2 秒才接受，实际 ${ms}ms`);
});

test('waitForNext：答卷区域暂时消失（指纹为空）不算换卷', async () => {
  const { doc, t } = page(`<div id="box"><img class="answer" src="http://localhost/a.png" /></div>`);
  fakeImg(doc.querySelector('img'));
  const cfg = baseCfg({ nextTimeoutMs: 800 });
  const before = t.adapter.fingerprintParts(cfg);
  doc.getElementById('box').replaceChildren();
  assert.equal(t.adapter.fingerprint(cfg), '');
  assert.equal(await t.adapter.waitForNext(cfg, before), false);
});

test('confirmUnchanged：页面短暂重绘后恢复，视为同一份答卷', async () => {
  const { doc, t } = page(`<img class="answer" src="http://localhost/a.png" />`);
  const img = doc.querySelector('img');
  fakeImg(img);
  const cfg = baseCfg();
  const expected = t.adapter.fingerprint(cfg);
  img.setAttribute('src', 'http://localhost/b.png');
  setTimeout(() => img.setAttribute('src', 'http://localhost/a.png'), 400);
  assert.equal(await t.adapter.confirmUnchanged(cfg, expected, 1500), null);
});

test('confirmUnchanged：真的换卷后返回新指纹', async () => {
  const { doc, t } = page(`<img class="answer" src="http://localhost/a.png" />`);
  const img = doc.querySelector('img');
  fakeImg(img);
  const cfg = baseCfg();
  const expected = t.adapter.fingerprint(cfg);
  img.setAttribute('src', 'http://localhost/b.png');
  assert.equal(await t.adapter.confirmUnchanged(cfg, expected, 300), 'http://localhost/b.png');
});

test('submit：提交按钮禁用时报错，不点击', async () => {
  const { doc, t } = page(`<button id="submit" disabled>提交</button>`);
  let clicked = false;
  doc.getElementById('submit').addEventListener('click', () => (clicked = true));
  await assert.rejects(t.adapter.submit(baseCfg()), /不可点击/);
  assert.equal(clicked, false);
});

test('detectPicType：点到 img / canvas / 背景图 / 容器', () => {
  const { doc, t } = page(`
    <div id="c1"><img id="i" src="x.png" /></div>
    <canvas id="cv"></canvas>
    <div id="bg" style="background-image:url('http://x/y.png')"><span id="inner">t</span></div>
    <div id="nothing">文字</div>
  `);
  assert.equal(t.wizard.detectPicType(doc.getElementById('i')).type, 'img');
  assert.equal(t.wizard.detectPicType(doc.getElementById('c1')).type, 'img');
  assert.equal(t.wizard.detectPicType(doc.getElementById('cv')).type, 'canvas');
  assert.equal(t.wizard.detectPicType(doc.getElementById('inner')).type, 'background');
  assert.equal(t.wizard.detectPicType(doc.getElementById('nothing')), null);
});

test('面板宿主内的元素不会被选择器命中', () => {
  const { t } = page(`<div id="easy-grader-host"><input id="score" /></div>`);
  assert.equal(t.dom.queryOne(['#score']), null);
});
