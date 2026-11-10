/**
 * 读取答卷图片：img / canvas / CSS 背景图 / 区域截图 四种方式，
 * 多张时纵向拼接，最后缩放并编码成 JPEG，控制上传体积。
 */
import type { PicConfig } from '../shared/adapter-config';
import { bg } from '../shared/protocol';
import { isVisible, queryAll } from './dom';

export class CaptureError extends Error {}

const MAX_WIDTH = 1600;
const MAX_TOTAL_HEIGHT = 4000;
/** 单张图原样上传的上限，留一点余量给服务端的 MAX_IMAGE_BYTES */
const MAX_DIRECT_BYTES = 3.5 * 1024 * 1024;

/** 估算 data URL 解码后的字节数 */
function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',');
  if (comma < 0) return Infinity;
  return Math.floor(((url.length - comma - 1) * 3) / 4);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new CaptureError('答卷图片加载失败'));
    img.src = src;
  });
}

/** 画到新 canvas 上读像素；跨域且无 CORS 时抛 SecurityError */
function pixelsOf(source: CanvasImageSource, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(source, 0, 0);
  return c.toDataURL('image/png');
}

async function fromUrl(url: string): Promise<string> {
  if (url.startsWith('data:image/')) return url;
  if (url.startsWith('blob:')) {
    const img = await loadImage(url);
    return pixelsOf(img, img.naturalWidth, img.naturalHeight);
  }
  // 交给后台下载：不受页面 CORS 限制，也不会污染画布
  return bg<string>({ cmd: 'image.fetch', url: new URL(url, location.href).href });
}

export function backgroundUrl(el: Element): string | null {
  const m = getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
  return m ? m[1] : null;
}

/** 可见区截图后按元素位置裁剪 */
async function fromRegion(el: Element): Promise<string> {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  await new Promise((r) => setTimeout(r, 150));
  const rect = el.getBoundingClientRect();
  const shot = await loadImage(await bg<string>({ cmd: 'tab.capture' }));
  const scale = shot.naturalWidth / window.innerWidth;
  const sx = Math.max(0, rect.left * scale);
  const sy = Math.max(0, rect.top * scale);
  const sw = Math.min(shot.naturalWidth - sx, rect.width * scale);
  const sh = Math.min(shot.naturalHeight - sy, rect.height * scale);
  if (sw < 10 || sh < 10) throw new CaptureError('答卷区域不在可见范围内，请滚动到答卷位置后重试');
  const c = document.createElement('canvas');
  c.width = Math.round(sw);
  c.height = Math.round(sh);
  c.getContext('2d')!.drawImage(shot, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

async function readOne(el: HTMLElement, type: PicConfig['type']): Promise<string> {
  if (type === 'region') return fromRegion(el);
  if (type === 'background') {
    const url = backgroundUrl(el);
    if (!url) throw new CaptureError('该元素没有背景图片');
    return fromUrl(url);
  }
  if (type === 'canvas') {
    const canvas = el instanceof HTMLCanvasElement ? el : el.querySelector('canvas');
    if (!canvas) throw new CaptureError('答卷区域里没有 canvas');
    // insert.ts 记录的原始图片地址通常比画到面板上的 canvas 分辨率高，优先用原图
    const src = canvas.getAttribute('data-eg-src');
    if (src) {
      try {
        return await fromUrl(src);
      } catch (e) {
        console.warn('[EasyGrader] 原图下载失败，回退到 canvas', e);
      }
    }
    try {
      return canvas.toDataURL('image/png');
    } catch {
      // 画布被跨域图片污染：用 insert.js 记录的原图地址，否则退回截图
      return src ? fromUrl(src) : fromRegion(canvas);
    }
  }
  const img = el instanceof HTMLImageElement ? el : el.querySelector('img');
  if (!img) throw new CaptureError('答卷区域里没有图片');
  if (!img.complete || !img.naturalWidth) await new Promise((r) => img.addEventListener('load', r, { once: true }));
  const src = img.currentSrc || img.src;
  if (src.startsWith('data:image/')) return src;
  try {
    return pixelsOf(img, img.naturalWidth, img.naturalHeight);
  } catch {
    return fromUrl(src);
  }
}

/** 纵向拼接、限宽缩放、转 JPEG */
async function compose(dataUrls: string[]): Promise<string> {
  const imgs = await Promise.all(dataUrls.map(loadImage));
  // 单张原图在尺寸和体积允许时直接使用：手写答卷再压缩一次会明显丢笔画细节
  if (dataUrls.length === 1) {
    const img = imgs[0];
    if (
      img.naturalWidth <= MAX_WIDTH &&
      img.naturalHeight <= MAX_TOTAL_HEIGHT &&
      dataUrlBytes(dataUrls[0]) <= MAX_DIRECT_BYTES
    ) {
      return dataUrls[0];
    }
  }
  const width = Math.min(MAX_WIDTH, Math.max(...imgs.map((i) => i.naturalWidth)));
  const heights = imgs.map((i) => (i.naturalHeight * width) / i.naturalWidth);
  const total = heights.reduce((a, b) => a + b, 0);
  const k = Math.min(1, MAX_TOTAL_HEIGHT / total);
  const c = document.createElement('canvas');
  c.width = Math.round(width * k);
  c.height = Math.round(total * k);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  let y = 0;
  imgs.forEach((img, i) => {
    const h = heights[i] * k;
    ctx.drawImage(img, 0, y, c.width, h);
    y += h;
  });
  return c.toDataURL('image/jpeg', 0.95);
}

function pickPics(cfg: PicConfig): HTMLElement[] {
  const els = queryAll(cfg.selectors).filter(isVisible);
  return cfg.multiple ? els : els.slice(0, 1);
}

/** 找不到答卷时把实际命中情况写进错误里，方便判断是选择器过期还是页面还没加载 */
function missingMessage(cfg: PicConfig): string {
  const matched = queryAll(cfg.selectors).length;
  const canvases = document.querySelectorAll('canvas').length;
  const images = document.querySelectorAll('img').length;
  return (
    `页面上找不到答卷图片（选择器 ${cfg.selectors.join(', ')} 命中 ${matched} 个元素，` +
    `页面共 ${canvases} 个 canvas、${images} 张 img），请确认答卷已加载，或重新点选适配`
  );
}

export function picElements(cfg: PicConfig): HTMLElement[] {
  const els = pickPics(cfg);
  if (!els.length) throw new CaptureError(missingMessage(cfg));
  return els;
}

/** 平台常在切卷/刷新后延迟渲染答卷，给图片一点出现的时间 */
async function waitForPics(cfg: PicConfig, timeoutMs: number): Promise<HTMLElement[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const els = pickPics(cfg);
    if (els.length) return els;
    if (Date.now() >= deadline) throw new CaptureError(missingMessage(cfg));
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function captureAnswer(cfg: PicConfig): Promise<string> {
  const parts: string[] = [];
  for (const el of await waitForPics(cfg, 3000)) parts.push(await readOne(el, cfg.type));
  return compose(parts);
}
