import '@testing-library/jest-dom/vitest';

// jsdom 没有实现 <dialog> 的 showModal / close：补上最小行为（切换 open 属性），让对话框在测试里可见
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}
