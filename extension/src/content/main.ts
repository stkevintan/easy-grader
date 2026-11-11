/** 内容脚本入口：只负责响应 popup 的打开/关闭面板请求，不主动改动页面 */
import type { TabRequest } from '../shared/protocol';
import { Panel } from './panel';

declare global {
  interface Window {
    __easyGrader?: Panel;
  }
}

// 同一页面重复注入（动态注册 + 手动注入）时只保留一个实例
if (!window.__easyGrader && window.top === window) {
  const panel = new Panel();
  window.__easyGrader = panel;
  chrome.runtime.onMessage.addListener((m: TabRequest, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (m.cmd === 'panel.unitChanged') {
      void panel.resetForUnitChange();
      sendResponse({ ok: true });
    } else if (m.cmd === 'panel.toggle') {
      panel.toggle();
      sendResponse({ ok: true });
    } else if (m.cmd === 'panel.status') {
      sendResponse(panel.status());
    }
    return false;
  });
}
