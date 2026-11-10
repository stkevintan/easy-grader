/**
 * 运行在页面主世界（MAIN world），document_start 注入。
 *
 * 阅卷平台常把跨域答卷图片画到 canvas 上，此时 canvas 被“污染”，toDataURL 会抛错。
 * 这里在 drawImage 时把来源图片地址记到 canvas 的 data-eg-src 属性上，
 * 内容脚本读不到像素时，就改由扩展后台按这个地址下载原图。
 * 只记录地址，不改变 drawImage 的行为。
 */
(() => {
  const proto = CanvasRenderingContext2D.prototype;
  const original = proto.drawImage;
  if ((original as unknown as { __eg?: boolean }).__eg) return;

  const patched = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    try {
      const src = args[0];
      const canvas = this.canvas as HTMLCanvasElement | undefined;
      if (canvas && typeof canvas.setAttribute === 'function') {
        if (src instanceof HTMLImageElement && src.currentSrc) {
          const url = new URL(src.currentSrc, location.href);
          if (url.origin !== location.origin && /^https?:$/.test(url.protocol)) canvas.setAttribute('data-eg-src', url.href);
        } else if (src instanceof HTMLCanvasElement) {
          const inherited = src.getAttribute('data-eg-src');
          if (inherited) canvas.setAttribute('data-eg-src', inherited);
        }
      }
    } catch {
      /* 忽略：记录失败不能影响页面绘制 */
    }
    return (original as (...a: unknown[]) => void).apply(this, args);
  };
  (patched as unknown as { __eg: boolean }).__eg = true;
  proto.drawImage = patched as typeof proto.drawImage;
})();
