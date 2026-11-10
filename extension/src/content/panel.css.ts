/** 面板样式（注入到 Shadow DOM，不影响也不受阅卷页面样式影响） */
export const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483645; width: 360px;
  max-height: calc(100vh - 32px); display: flex; flex-direction: column; background: #fff;
  color: #0f172a; border-radius: 12px;
  box-shadow: 0 10px 40px rgba(15,23,42,.22), 0 0 0 1px rgba(15,23,42,.06);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
.panel.min .body, .panel.min .foot { display: none; }
/* 点选/等待输入期间：只保留标题栏和提示，挪到左上角，不挡页面 */
.panel.picking { right: auto !important; bottom: auto !important; left: 16px; top: 64px; width: 300px; opacity: .92; }
.panel.picking .foot, .panel.picking .body > :not(.msg) { display: none; }
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid #e2e8f0; cursor: move; user-select: none; }
.head b { flex: 1; font-size: 14px; }
.credits { color: #475569; font-size: 12px; }
.icon { border: 0; background: transparent; cursor: pointer; font-size: 16px; line-height: 1;
  padding: 2px 6px; color: #64748b; border-radius: 4px; }
.icon:hover { background: #f1f5f9; }
.icon:focus-visible, .btn:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
.body { padding: 12px; overflow: auto; }
.foot { padding: 8px 12px; border-top: 1px solid #e2e8f0; display: flex; gap: 8px; flex-wrap: wrap; }
h4 { margin: 12px 0 6px; font-size: 13px; color: #334155; }
h4:first-child { margin-top: 0; }
label { display: block; margin: 8px 0 3px; color: #475569; font-size: 12px; }
input, select, textarea { width: 100%; font: inherit; padding: 6px 8px; border: 1px solid #cbd5e1;
  border-radius: 6px; background: #fff; color: inherit; }
textarea { resize: vertical; min-height: 56px; }
input:focus, select:focus, textarea:focus { outline: 2px solid #93c5fd; border-color: #60a5fa; }
input[type=checkbox] { width: auto; margin: 0 6px 0 0; vertical-align: -2px; }
.row { display: flex; gap: 8px; }
.row > * { flex: 1; min-width: 0; }
.btn { font: inherit; padding: 7px 12px; border-radius: 6px; border: 1px solid #cbd5e1;
  background: #fff; color: #0f172a; cursor: pointer; white-space: nowrap; }
.btn:hover:not(:disabled) { background: #f8fafc; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.btn.primary:hover:not(:disabled) { background: #1d4ed8; }
.btn.danger { color: #b91c1c; border-color: #fecaca; }
.btn.grow { flex: 1; }
/* ready 视图的按钮文字长，让主按钮独占一行，避免被挤成一字一行 */
.foot.stack .btn.grow { flex: 1 1 100%; }
.foot.stack > .btn:not(.grow) { flex: 1 1 0; }
.muted { color: #64748b; font-size: 12px; }
.msg { margin: 8px 0; padding: 8px 10px; border-radius: 6px; font-size: 12px; white-space: pre-line; }
.msg.info { background: #eff6ff; color: #1e40af; }
.msg.ok { background: #f0fdf4; color: #166534; }
.msg.warn { background: #fffbeb; color: #92400e; }
.msg.error { background: #fef2f2; color: #991b1b; }
.score { display: flex; align-items: baseline; gap: 6px; margin: 4px 0 8px; }
.score input { width: 90px; font-size: 26px; font-weight: 600; padding: 2px 8px; }
.score .max { font-size: 16px; color: #64748b; }
.conf { font-size: 12px; padding: 2px 8px; border-radius: 999px; }
.conf.high { background: #dcfce7; color: #166534; }
.conf.mid { background: #fef9c3; color: #854d0e; }
.conf.low { background: #fee2e2; color: #991b1b; }
ul.reasons { margin: 4px 0 8px; padding-left: 18px; }
ul.reasons li { margin: 2px 0; }
details { margin-top: 6px; }
summary { cursor: pointer; color: #475569; font-size: 12px; }
pre.ocr { white-space: pre-wrap; background: #f8fafc; padding: 8px; border-radius: 6px;
  font: 12px/1.5 inherit; max-height: 160px; overflow: auto; margin: 6px 0 0; }
.steps { margin: 0; padding: 0; list-style: none; }
.steps li { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px dashed #e2e8f0; }
.steps li:last-child { border-bottom: 0; }
.steps .name { flex: 1; }
.steps .state { font-size: 12px; color: #64748b; max-width: 150px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.steps .state.done { color: #15803d; }
.kv { display: grid; grid-template-columns: 64px 1fr; gap: 2px 8px; font-size: 12px; }
.kv dt { color: #64748b; }
.kv dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stat { font-size: 12px; color: #475569; }
`;
