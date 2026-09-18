// 共享视口布局：三路预览（原始 / 遮罩 / 合成），均为 16:9，cover 填充
export function computeTripleLayout(cssW, cssH, dpr) {
  const W = Math.max(64, Math.round(cssW * dpr));
  const H = Math.max(64, Math.round(cssH * dpr));
  // 无缝三等分：边界用累积取整，pane 宽度为相邻边界之差
  const bounds = [0];
  for (let i = 1; i < 3; i++) bounds.push(Math.round((W * i) / 3));
  bounds.push(W);
  const panes = [];
  for (let i = 0; i < 3; i++) {
    panes.push({ x: bounds[i], y: 0, w: bounds[i + 1] - bounds[i], h: H });
  }
  return { W, H, panes, dpr };
}

// cover 模式下，pane 内归一化坐标 → 工作纹理 UV（源与 pane 宽高比不同时裁切）
export function paneToUv(nx, ny, srcAspect, paneAspect) {
  // srcAspect = workW/workH; paneAspect ~ 16/9
  let u = nx, v = ny;
  if (srcAspect > paneAspect) {
    // 源更宽：水平方向裁
    const visible = paneAspect / srcAspect;
    u = (nx - 0.5) * visible + 0.5;
  } else {
    const visible = srcAspect / paneAspect;
    v = (ny - 0.5) * visible + 0.5;
  }
  return [u, v];
}
