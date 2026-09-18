// 遮罩 alpha 直方图绘制
export function drawHistogram(canvas, bins) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#141820';
  ctx.fillRect(0, 0, w, h);
  if (!bins || !bins.length) return;
  const max = Math.max(1, ...bins);
  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  for (let i = 1; i < 4; i++) {
    const x = (w / 4) * i;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  const bw = w / bins.length;
  for (let i = 0; i < bins.length; i++) {
    const v = bins[i] / max;
    // 0 附近红色（被抠掉），中间黄色（羽化），255 绿色（保留）
    let col;
    if (i < 64) col = 'rgba(239,68,68,.85)';
    else if (i < 192) col = 'rgba(250,204,21,.7)';
    else col = 'rgba(34,197,94,.85)';
    ctx.fillStyle = col;
    ctx.fillRect(i * bw, h - v * h, Math.max(1, bw - 0.3), v * h);
  }
  ctx.fillStyle = '#8b93a1'; ctx.font = '9px sans-serif';
  ctx.fillText('α 0', 2, h - 3);
  ctx.fillText('128', w / 2 - 8, h - 3);
  ctx.fillText('255', w - 18, h - 3);
}
