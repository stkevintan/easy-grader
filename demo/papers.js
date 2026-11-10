/* 模拟答卷数据与绘制（两个演示页共用） */
window.PAPERS = [
  '作者通过回忆童年在外婆家度过的夏天，表达了对外婆的思念，以及对淳朴乡村生活的怀念。',
  '文章写了外婆家的院子、葡萄架和夏夜乘凉，抒发了怀念之情。',
  '写了外婆。',
  '本文以时间为线索，先写初到外婆家的新奇，再写和外婆一起劳作的快乐，最后写离别时的不舍，表达了对亲情的珍视和对逝去时光的感慨。',
  '',
];

/** 把文字画成“手写答卷”：格子纸 + 略微抖动的字 */
window.drawPaper = function drawPaper(canvas, text, seed) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#fffdf7';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#f3c6c6';
  ctx.lineWidth = 1;
  const cell = 36;
  for (let y = 60; y < H - 20; y += cell) {
    ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(W - 30, y); ctx.stroke();
  }
  ctx.fillStyle = '#9ca3af';
  ctx.font = '14px sans-serif';
  ctx.fillText('17. 请概括文章的主要内容，并说说作者表达了怎样的情感。（6 分）', 30, 30);
  ctx.fillText('考号：2026' + String(1001 + seed), W - 170, 30);

  let rnd = 9301 * (seed + 7);
  const jitter = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280 - 0.5) * 3;
  ctx.fillStyle = '#1e293b';
  ctx.font = '26px "Kaiti SC", "STKaiti", "KaiTi", serif';
  let x = 40;
  let y = 60 + cell - 8;
  for (const ch of text) {
    const w = ctx.measureText(ch).width + 2;
    if (x + w > W - 40) { x = 40; y += cell; }
    if (y > H - 20) break;
    ctx.fillText(ch, x + jitter(), y + jitter());
    x += w;
  }
  if (!text) {
    ctx.fillStyle = '#d1d5db';
    ctx.font = '18px sans-serif';
    ctx.fillText('（空白）', 40, 60 + cell - 8);
  }
};

/** 生成答卷图片的 data URL（buttons 页用 <img> 展示） */
window.paperDataUrl = function paperDataUrl(text, seed) {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 420;
  window.drawPaper(c, text, seed);
  return c.toDataURL('image/png');
};
