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
  // 所有打开的阅卷页都监听当前单元：popup 切换后，每个标签页的面板都会重置并按新单元重新加载，
  // 而不是只通知当前标签页、让其他标签页继续用旧单元的题目和适配配置。
  chrome.storage.onChanged.addListener((changes, area) => {
    const unit = changes.activeUnitId;
    if (area === 'local' && unit && unit.oldValue !== unit.newValue) void panel.resetForUnitChange();
  });
  chrome.runtime.onMessage.addListener((m: TabRequest, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (m.cmd === 'panel.toggle') {
      panel.toggle();
      sendResponse({ ok: true });
    } else if (m.cmd === 'panel.status') {
      sendResponse(panel.status());
    }
    return false;
  });
}
