// Easy Grader 管理后台：无构建步骤的原生 ES module。
// 所有用户数据都通过 textContent / 属性写入，不拼接 innerHTML，避免 XSS。

const TOKEN_KEY = 'eg-admin-token';
let token = sessionStorage.getItem(TOKEN_KEY) || '';
let me = null;

// ---------- 工具 ----------

/** h('button', { class: 'x', onclick }, '文字', child) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const $ = (id) => document.getElementById(id);
const fmtTime = (s) => (s ? new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') || String(s).includes('+') ? '' : 'Z')).toLocaleString('zh-CN', { hour12: false }) : '—');
const fmtNum = (n, d = 1) => (n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : Number(n).toFixed(d));

function toast(text, bad = false) {
  const t = h('div', { class: `t${bad ? ' bad' : ''}` }, text);
  $('toast').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3000);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout(true);
    throw new ApiError('登录已失效，请重新登录', 401);
  }
  if (!res.ok) {
    const msg = Array.isArray(data.message) ? data.message.join('；') : data.message;
    throw new ApiError(msg || `请求失败（HTTP ${res.status}）`, res.status);
  }
  return data;
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString();

// ---------- 对话框 ----------

/**
 * 打开一个表单对话框。fields: [{ name, label, type, value, ... }]
 * onSubmit(values) 返回 false 或抛错则不关闭。
 */
function openDialog({ title, fields = [], submitText = '确定', onSubmit, extra }) {
  const dlg = $('dialog');
  const form = $('dialog-form');
  const inputs = {};
  const err = h('p', { class: 'error', role: 'alert' });
  const rows = fields.map((f) => {
    const id = `f-${f.name}`;
    let input;
    if (f.type === 'select') {
      input = h('select', { id, name: f.name }, ...f.options.map(([v, l]) => h('option', { value: v }, l)));
      input.value = f.value ?? f.options[0][0];
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, name: f.name, spellcheck: 'false', readonly: f.readonly });
      input.value = f.value ?? '';
    } else if (f.type === 'checkbox') {
      input = h('input', { id, name: f.name, type: 'checkbox', checked: f.value });
      inputs[f.name] = input;
      return h('label', { class: 'check', for: id }, input, f.label);
    } else {
      input = h('input', { id, name: f.name, type: f.type || 'text', value: f.value ?? '', required: f.required, min: f.min, max: f.max, step: f.step, placeholder: f.placeholder, maxlength: f.maxlength, autocomplete: f.autocomplete || 'off' });
    }
    inputs[f.name] = input;
    return h('div', {}, h('label', { for: id }, f.label), input, f.hint ? h('div', { class: 'muted' }, f.hint) : null);
  });
  const cancel = h('button', { type: 'button', onclick: () => dlg.close() }, onSubmit ? '取消' : '关闭');
  const ok = onSubmit ? h('button', { class: 'primary', type: 'submit' }, submitText) : null;
  form.replaceChildren(h('h2', {}, title), ...rows, extra ?? null, err, h('div', { class: 'btns' }, cancel, ok));
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!onSubmit) return dlg.close();
    err.textContent = '';
    const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
    ok.disabled = true;
    try {
      if ((await onSubmit(values)) !== false) dlg.close();
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      ok.disabled = false;
    }
  };
  dlg.showModal();
  (Object.values(inputs)[0] || ok || cancel).focus();
}

function confirmDialog(title, text, onOk) {
  openDialog({ title, extra: h('p', {}, text), submitText: '确定', onSubmit: onOk });
}

// ---------- 登录 ----------

function logout(expired = false) {
  token = '';
  me = null;
  sessionStorage.removeItem(TOKEN_KEY);
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  if (expired) $('login-error').textContent = '登录已失效，请重新登录';
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    const r = await api('POST', '/api/auth/login', { username: $('login-user').value.trim(), password: $('login-pass').value });
    if (r.user.role !== 'admin') {
      token = '';
      throw new Error('该账号不是管理员');
    }
    token = r.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    $('login-pass').value = '';
    await enter();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', () => logout());
$('change-pass').addEventListener('click', () =>
  openDialog({
    title: '修改我的密码',
    fields: [
      { name: 'oldPassword', label: '原密码', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'newPassword', label: '新密码（至少 8 位）', type: 'password', required: true, autocomplete: 'new-password' },
    ],
    onSubmit: async (v) => {
      const r = await api('POST', '/api/auth/password', v);
      token = r.token;
      sessionStorage.setItem(TOKEN_KEY, token);
      toast('密码已修改');
    },
  }),
);

async function enter() {
  me = await api('GET', '/api/auth/me');
  if (me.role !== 'admin') return logout();
  $('me').textContent = `${me.username}（管理员）`;
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  route();
}

// ---------- 通用列表页 ----------

/**
 * 分页表格。cols: [{ title, render(row) -> Node|string, wrap? }]
 * load({ page, q }) -> { items, total, page, pageSize }
 */
function listPage({ title, cols, load, toolbar = [], searchPlaceholder, empty = '暂无数据' }) {
  const state = { page: 1, q: '' };
  const body = h('div', { class: 'table-wrap' });
  const pager = h('div', { class: 'pager' });
  const search = searchPlaceholder
    ? h('input', { type: 'search', placeholder: searchPlaceholder, 'aria-label': searchPlaceholder })
    : null;
  let timer;
  search?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = search.value.trim();
      state.page = 1;
      refresh();
    }, 300);
  });

  async function refresh() {
    body.replaceChildren(h('div', { class: 'empty' }, '加载中…'));
    try {
      const r = await load(state);
      const items = Array.isArray(r) ? r : r.items;
      if (!items.length) {
        body.replaceChildren(h('div', { class: 'empty' }, empty));
        pager.replaceChildren();
        return;
      }
      body.replaceChildren(
        h('table', {},
          h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', { scope: 'col' }, c.title)))),
          h('tbody', {}, ...items.map((row) => h('tr', {}, ...cols.map((c) => h('td', { class: c.wrap ? 'wrap' : undefined }, c.render(row) ?? '—'))))),
        ),
      );
      if (Array.isArray(r)) return pager.replaceChildren(h('span', { class: 'muted' }, `共 ${items.length} 条`));
      const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
      pager.replaceChildren(
        h('span', { class: 'muted' }, `共 ${r.total} 条 · 第 ${r.page}/${pages} 页`),
        h('button', { disabled: r.page <= 1, onclick: () => { state.page -= 1; refresh(); } }, '上一页'),
        h('button', { disabled: r.page >= pages, onclick: () => { state.page += 1; refresh(); } }, '下一页'),
      );
    } catch (e) {
      body.replaceChildren(h('div', { class: 'empty error' }, e.message));
    }
  }

  const view = h('div', {},
    h('h1', {}, title),
    h('div', { class: 'toolbar' }, search, h('span', { class: 'spacer' }), ...toolbar.map((t) => (typeof t === 'function' ? t(refresh) : t))),
    h('div', { class: 'card', style: 'padding:0;overflow:hidden' }, body),
    pager,
  );
  refresh();
  return view;
}

const tag = (text, kind = '') => h('span', { class: `tag ${kind}` }, text);
const actions = (...btns) => h('div', { class: 'actions' }, ...btns);
const linkBtn = (text, onclick, cls = '') => h('button', { class: `link ${cls}`, type: 'button', onclick }, text);

// ---------- 概览 ----------

function dashboardPage() {
  const view = h('div', {}, h('h1', {}, '概览'), h('div', { class: 'empty' }, '加载中…'));
  api('GET', '/api/admin/stats')
    .then((s) => {
      const stat = (k, v, hint) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k), hint ? h('div', { class: 'muted' }, hint) : null);
      const confirmRate = s.records ? Math.round((s.confirmed / s.records) * 100) : 0;
      const max = Math.max(1, ...s.daily.map((d) => d.done + d.failed));
      const days = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        days.push(s.daily.find((x) => x.day === d) ?? { day: d, done: 0, failed: 0, users: 0 });
      }
      view.replaceChildren(
        h('h1', {}, '概览'),
        h('div', { class: 'grid' },
          stat('用户数', s.users),
          stat('阅卷任务', s.tasks),
          stat('成功评分', s.records, `失败 ${s.failed}`),
          stat('老师确认率', `${confirmRate}%`, `${s.confirmed} 份已确认`),
          stat('平均耗时', `${(s.avgLatencyMs / 1000).toFixed(1)}s`),
          stat('平均置信度', `${Math.round(s.avgConfidence * 100)}%`),
          stat('AI 与终分平均偏差', fmtNum(s.avgDrift, 2), '越小说明 AI 越准'),
          stat('未用额度', s.creditsOutstanding, '所有用户余额合计'),
        ),
        h('div', { class: 'card' },
          h('h2', {}, '近 14 天评分量'),
          h('div', { class: 'bars', role: 'img', 'aria-label': '近 14 天每日评分数量柱状图' },
            ...days.map((d) =>
              h('div', { class: 'bar', title: `${d.day}：成功 ${d.done}，失败 ${d.failed}，${d.users} 位老师` },
                h('span', { class: 'num' }, d.done + d.failed || ''),
                d.failed ? h('div', { class: 'fill failed', style: `height:${Math.max(2, (d.failed / max) * 110)}px` }) : null,
                d.done ? h('div', { class: 'fill', style: `height:${Math.max(2, (d.done / max) * 110)}px` }) : null,
                h('div', { class: 'base' }),
                h('span', { class: 'lbl' }, d.day.slice(5)),
              ),
            ),
          ),
          h('p', { class: 'muted' }, '蓝色为成功，红色为失败（失败不扣次数）。'),
        ),
      );
    })
    .catch((e) => view.replaceChildren(h('h1', {}, '概览'), h('p', { class: 'error' }, e.message)));
  return view;
}

// ---------- 用户 ----------

function usersPage() {
  const adjust = (u, refresh) =>
    openDialog({
      title: `调整额度：${u.username}`,
      fields: [
        { name: 'delta', label: `增减次数（当前 ${u.credits}，负数为扣减）`, type: 'number', required: true, step: 1, value: 50 },
        { name: 'note', label: '备注', maxlength: 200, placeholder: '例如：学校采购 / 补偿' },
      ],
      onSubmit: async (v) => {
        const delta = Number(v.delta);
        if (!Number.isInteger(delta) || delta === 0) throw new Error('请输入非零整数');
        const r = await api('POST', `/api/admin/users/${u.id}/credits`, { delta, note: v.note || undefined });
        toast(`已调整，${u.username} 当前余额 ${r.balance}`);
        refresh();
      },
    });
  const resetPass = (u) =>
    openDialog({
      title: `重置密码：${u.username}`,
      fields: [{ name: 'password', label: '新密码（至少 8 位）', type: 'password', required: true, autocomplete: 'new-password' }],
      onSubmit: async (v) => {
        await api('PATCH', `/api/admin/users/${u.id}`, { password: v.password });
        toast('密码已重置，该用户需要重新登录');
      },
    });
  const toggle = (u, refresh) =>
    confirmDialog(u.disabled ? '启用账号' : '停用账号', u.disabled ? `确定启用 ${u.username}？` : `停用后 ${u.username} 会立即被登出且无法登录，确定？`, async () => {
      await api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled });
      toast(u.disabled ? '已启用' : '已停用');
      refresh();
    });
  const role = (u, refresh) =>
    confirmDialog('修改角色', u.role === 'admin' ? `取消 ${u.username} 的管理员权限？` : `把 ${u.username} 设为管理员？管理员可以管理所有用户和额度。`, async () => {
      await api('PATCH', `/api/admin/users/${u.id}`, { role: u.role === 'admin' ? 'user' : 'admin' });
      toast('角色已修改');
      refresh();
    });

  return listPage({
    title: '用户',
    searchPlaceholder: '搜索用户名',
    load: ({ page, q }) => api('GET', `/api/admin/users?${qs({ page, q })}`),
    toolbar: [
      (refresh) =>
        h('button', {
          class: 'primary',
          onclick: () =>
            openDialog({
              title: '新建用户',
              fields: [
                { name: 'username', label: '用户名（3-32 位）', required: true, maxlength: 32 },
                { name: 'password', label: '初始密码（至少 8 位）', type: 'password', required: true, autocomplete: 'new-password' },
                { name: 'credits', label: '初始次数', type: 'number', min: 0, step: 1, value: 0 },
                { name: 'role', label: '角色', type: 'select', options: [['user', '普通用户'], ['admin', '管理员']] },
              ],
              onSubmit: async (v) => {
                await api('POST', '/api/admin/users', { username: v.username.trim(), password: v.password, credits: Number(v.credits) || 0, role: v.role });
                toast('已创建');
                refresh();
              },
            }),
        }, '新建用户'),
    ],
    cols: [
      { title: 'ID', render: (u) => u.id },
      { title: '用户名', render: (u) => h('span', {}, u.username, ' ', u.role === 'admin' ? tag('管理员', 'brand') : null, u.disabled ? tag('已停用', 'bad') : null) },
      { title: '剩余次数', render: (u) => u.credits },
      { title: '已评分', render: (u) => u.judged },
      { title: '最近评分', render: (u) => fmtTime(u.lastJudgeAt) },
      { title: '最近登录', render: (u) => fmtTime(u.lastLoginAt) },
      { title: '注册时间', render: (u) => fmtTime(u.createdAt) },
      {
        title: '操作',
        render: (u) => {
          const refresh = () => route();
          const self = me && u.id === me.id;
          return actions(
            linkBtn('调额度', () => adjust(u, refresh)),
            linkBtn('流水', () => (location.hash = `#/ledger?userId=${u.id}`)),
            linkBtn('重置密码', () => resetPass(u)),
            self ? null : linkBtn(u.role === 'admin' ? '取消管理员' : '设为管理员', () => role(u, refresh)),
            self ? null : linkBtn(u.disabled ? '启用' : '停用', () => toggle(u, refresh), u.disabled ? '' : 'danger'),
          );
        },
      },
    ],
  });
}

// ---------- 兑换码 ----------

function codesPage() {
  return listPage({
    title: '兑换码',
    searchPlaceholder: '搜索兑换码或备注',
    load: ({ page, q }) => api('GET', `/api/admin/codes?${qs({ page, q })}`),
    toolbar: [
      (refresh) =>
        h('button', {
          class: 'primary',
          onclick: () =>
            openDialog({
              title: '生成兑换码',
              fields: [
                { name: 'count', label: '生成数量（1-500）', type: 'number', min: 1, max: 500, step: 1, value: 10, required: true },
                { name: 'credits', label: '每个码的次数', type: 'number', min: 1, step: 1, value: 100, required: true },
                { name: 'maxUses', label: '每个码可被几个人使用', type: 'number', min: 1, step: 1, value: 1, hint: '1 表示一人一码；大于 1 适合发给一个教研组共用（每人限兑一次）' },
                { name: 'expiresAt', label: '过期日期（可选）', type: 'date' },
                { name: 'note', label: '备注', maxlength: 200, placeholder: '例如：XX 中学 2026 秋季' },
              ],
              submitText: '生成',
              onSubmit: async (v) => {
                const r = await api('POST', '/api/admin/codes', {
                  count: Number(v.count),
                  credits: Number(v.credits),
                  maxUses: Number(v.maxUses) || 1,
                  expiresAt: v.expiresAt ? new Date(`${v.expiresAt}T23:59:59`).toISOString() : undefined,
                  note: v.note || undefined,
                });
                refresh();
                // 生成后立即展示，方便复制
                setTimeout(() =>
                  openDialog({
                    title: `已生成 ${r.codes.length} 个兑换码`,
                    fields: [{ name: 'codes', label: '复制后分发给老师', type: 'textarea', value: r.codes.join('\n'), readonly: true }],
                    extra: h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(r.codes.join('\n')).then(() => toast('已复制')) }, '复制全部'),
                  }),
                );
              },
            }),
        }, '生成兑换码'),
    ],
    cols: [
      { title: '兑换码', render: (c) => h('code', {}, c.code) },
      { title: '次数', render: (c) => c.credits },
      { title: '已用/上限', render: (c) => `${c.usedCount} / ${c.maxUses}` },
      {
        title: '状态',
        render: (c) => {
          if (c.disabled) return tag('已停用', 'bad');
          if (c.expiresAt && new Date(String(c.expiresAt).replace(' ', 'T') + 'Z') < new Date()) return tag('已过期', 'warn');
          if (c.usedCount >= c.maxUses) return tag('已用完');
          return tag('可用', 'ok');
        },
      },
      { title: '过期时间', render: (c) => fmtTime(c.expiresAt) },
      { title: '备注', render: (c) => c.note || '—', wrap: true },
      { title: '创建时间', render: (c) => fmtTime(c.createdAt) },
      {
        title: '操作',
        render: (c) =>
          actions(
            linkBtn('复制', () => navigator.clipboard.writeText(c.code).then(() => toast('已复制'))),
            linkBtn(c.disabled ? '启用' : '停用', async () => {
              try {
                await api('PATCH', `/api/admin/codes/${c.id}`, { disabled: !c.disabled });
                toast(c.disabled ? '已启用' : '已停用');
                route();
              } catch (e) {
                toast(e.message, true);
              }
            }, c.disabled ? '' : 'danger'),
          ),
      },
    ],
  });
}

// ---------- 评分记录 ----------

function recordsPage(params) {
  return listPage({
    title: '评分记录',
    searchPlaceholder: '搜索用户名 / 考试 / 平台',
    empty: '还没有评分记录',
    load: ({ page, q }) => api('GET', `/api/admin/records?${qs({ page, q, userId: params.get('userId') })}`),
    cols: [
      { title: 'ID', render: (r) => r.id },
      { title: '时间', render: (r) => fmtTime(r.createdAt) },
      { title: '用户', render: (r) => r.username },
      { title: '考试 / 题号', render: (r) => `${r.examTitle ?? '（已删除）'} · ${r.questionNo ?? ''}`, wrap: true },
      { title: '平台', render: (r) => r.platformHost },
      { title: '状态', render: (r) => (r.status === 'done' ? tag('成功', 'ok') : h('span', { title: r.error }, tag('失败', 'bad'))) },
      { title: 'AI 分', render: (r) => (r.aiScore === null ? '—' : `${fmtNum(r.aiScore)} / ${fmtNum(r.maxScore)}`) },
      {
        title: '终分',
        render: (r) => {
          if (r.finalScore === null) return h('span', { class: 'muted' }, '未确认');
          const diff = Math.abs(r.finalScore - r.aiScore);
          return h('span', {}, fmtNum(r.finalScore), ' ', diff > 0 ? tag(`改 ${fmtNum(diff)}`, diff >= 2 ? 'warn' : '') : null);
        },
      },
      { title: '置信度', render: (r) => (r.confidence === null ? '—' : `${Math.round(r.confidence * 100)}%`) },
      { title: '模型', render: (r) => r.model || '—' },
      { title: '耗时', render: (r) => `${(r.latencyMs / 1000).toFixed(1)}s` },
      { title: '错误', render: (r) => r.error || '', wrap: true },
    ],
  });
}

// ---------- 额度流水 ----------

const REASONS = { register: '注册赠送', redeem: '兑换码', judge: '评分扣减', refund: '失败退还', admin: '管理员调整' };

function ledgerPage(params) {
  const userId = params.get('userId');
  return listPage({
    title: userId ? `额度流水（用户 #${userId}）` : '额度流水',
    load: ({ page }) => api('GET', `/api/admin/ledger?${qs({ page, userId })}`),
    toolbar: userId ? [h('button', { onclick: () => (location.hash = '#/ledger') }, '查看全部')] : [],
    cols: [
      { title: 'ID', render: (l) => l.id },
      { title: '时间', render: (l) => fmtTime(l.createdAt) },
      { title: '用户 ID', render: (l) => linkBtn(String(l.userId), () => (location.hash = `#/ledger?userId=${l.userId}`)) },
      { title: '类型', render: (l) => tag(REASONS[l.reason] ?? l.reason, l.delta > 0 ? 'ok' : '') },
      { title: '变动', render: (l) => h('span', { style: `color:${l.delta > 0 ? 'var(--ok)' : 'var(--bad)'}` }, l.delta > 0 ? `+${l.delta}` : String(l.delta)) },
      { title: '余额', render: (l) => l.balanceAfter },
      { title: '备注', render: (l) => l.note || '—', wrap: true },
    ],
  });
}

// ---------- 适配预设 ----------

const EXAMPLE_CONFIG = {
  version: 1,
  pics: { selectors: ['#answer img'], type: 'img', multiple: false },
  scoreMode: 'input',
  scoreInput: { selectors: ['input.score'] },
  scoreButtons: { selectors: [], clickType: 'click' },
  submit: { selectors: ['button.submit'], clickType: 'click' },
  confirm: { selectors: [] },
  examTitle: { selectors: ['.exam-name'] },
  questionNo: { selectors: ['.question-no'] },
  nextTimeoutMs: 8000,
  submitDelayMs: 300,
};

function presetDialog(p, refresh) {
  openDialog({
    title: p ? `编辑预设：${p.name}` : '新建适配预设',
    fields: [
      { name: 'name', label: '名称', required: true, maxlength: 100, value: p?.name },
      { name: 'hostPattern', label: '域名（会同时匹配子域名）', required: true, maxlength: 255, value: p?.hostPattern, placeholder: 'xiaoxianai.cn' },
      { name: 'pathPattern', label: '路径包含（可选）', maxlength: 200, value: p?.pathPattern, placeholder: '/mark/' },
      { name: 'scope', label: '可见范围', type: 'select', value: p?.scope ?? 'public', options: [['public', '公共：所有用户可用'], ['private', '私有：仅创建者']] },
      { name: 'enabled', label: '启用', type: 'checkbox', value: p ? p.enabled : true },
      { name: 'config', label: '选择器配置（JSON）', type: 'textarea', value: JSON.stringify(p?.config ?? EXAMPLE_CONFIG, null, 2) },
      { name: 'note', label: '备注', maxlength: 500, value: p?.note },
    ],
    onSubmit: async (v) => {
      let config;
      try {
        config = JSON.parse(v.config);
      } catch {
        throw new Error('配置不是合法的 JSON');
      }
      const body = { name: v.name.trim(), hostPattern: v.hostPattern.trim(), pathPattern: v.pathPattern.trim(), scope: v.scope, enabled: v.enabled, config, note: v.note };
      if (p) await api('PATCH', `/api/admin/presets/${p.id}`, body);
      else await api('POST', '/api/admin/presets', body);
      toast('已保存');
      refresh();
    },
  });
}

function presetsPage() {
  return listPage({
    title: '适配预设',
    searchPlaceholder: '搜索名称或域名',
    empty: '还没有预设。老师在扩展里点选适配后，会出现在这里。',
    load: ({ q }) => api('GET', `/api/admin/presets?${qs({ q })}`),
    toolbar: [
      h('span', { class: 'muted' }, '老师自己点选生成的是私有预设；验证可用后可改为公共，供所有人使用。'),
      (refresh) => h('button', { class: 'primary', onclick: () => presetDialog(null, refresh) }, '新建预设'),
    ],
    cols: [
      { title: 'ID', render: (p) => p.id },
      { title: '名称', render: (p) => p.name, wrap: true },
      { title: '匹配', render: (p) => h('code', {}, p.hostPattern + (p.pathPattern ? ` · ${p.pathPattern}` : '')) },
      { title: '给分方式', render: (p) => (p.config.scoreMode === 'buttons' ? '打分板' : '输入框') },
      { title: '答卷', render: (p) => `${p.config.pics.type}${p.config.pics.multiple ? ' ×多' : ''}` },
      { title: '范围', render: (p) => (p.scope === 'public' ? tag('公共', 'brand') : tag(`私有 · 用户 #${p.ownerId}`)) },
      { title: '状态', render: (p) => (p.enabled ? tag('启用', 'ok') : tag('停用', 'bad')) },
      { title: '更新时间', render: (p) => fmtTime(p.updatedAt) },
      {
        title: '操作',
        render: (p) => {
          const refresh = () => route();
          return actions(
            linkBtn('编辑', () => presetDialog(p, refresh)),
            p.scope === 'private'
              ? linkBtn('设为公共', () =>
                  confirmDialog('设为公共预设', `所有用户访问 ${p.hostPattern} 时都会用这份配置。请确认已在真实页面验证过。`, async () => {
                    await api('PATCH', `/api/admin/presets/${p.id}`, { scope: 'public' });
                    toast('已设为公共');
                    refresh();
                  }),
                )
              : null,
            linkBtn(p.enabled ? '停用' : '启用', async () => {
              try {
                await api('PATCH', `/api/admin/presets/${p.id}`, { enabled: !p.enabled });
                refresh();
              } catch (e) {
                toast(e.message, true);
              }
            }),
            linkBtn('删除', () =>
              confirmDialog('删除预设', `确定删除「${p.name}」？此操作不可撤销。`, async () => {
                await api('DELETE', `/api/admin/presets/${p.id}`);
                toast('已删除');
                refresh();
              }), 'danger'),
          );
        },
      },
    ],
  });
}

// ---------- 路由 ----------

const ROUTES = { dashboard: dashboardPage, users: usersPage, codes: codesPage, records: recordsPage, presets: presetsPage, ledger: ledgerPage };

function route() {
  if (!me) return;
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const name = ROUTES[path] ? path : 'dashboard';
  document.querySelectorAll('.side a').forEach((a) => {
    const on = a.dataset.route === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const main = $('main');
  main.replaceChildren(ROUTES[name](new URLSearchParams(query)));
  document.title = `${document.querySelector(`.side a[data-route="${name}"]`)?.textContent ?? ''} · Easy Grader 管理后台`;
}

window.addEventListener('hashchange', () => {
  route();
  $('main').focus();
});

// ---------- 启动 ----------

if (token) enter().catch(() => logout(true));
else logout();
