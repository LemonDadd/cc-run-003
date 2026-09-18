// 分屏对比 + 放大镜：从引擎 canvas（preserveDrawingBuffer）直接切片绘制
// paneRects 为引擎三路视口在 backing store 中的矩形 [{x,y,w,h}]

export class CompareView {
  constructor(canvas, sourceCanvas, getPanes) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.src = sourceCanvas;
    this.getPanes = getPanes; // () => panes
    this.split = 0.5;
    this.orientation = 'h';  // h: 左原右合; v: 上原下合
    this.zoomPos = null;     // {x,y} CSS 像素坐标
    this.showBefore = false;
    this.mouseDown = false;
    this.zoomLevel = 3;
    this._bind();
  }

  _rect(el) {
    const r = el.getBoundingClientRect();
    return r;
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointermove', (e) => {
      const r = this._rect(c);
      const x = e.clientX - r.left, y = e.clientY - r.top;
      this.zoomPos = { x, y, w: r.width, h: r.height };
      if (this.mouseDown) {
        if (this.orientation === 'h') this.split = Math.max(0.05, Math.min(0.95, x / r.width));
        else this.split = Math.max(0.05, Math.min(0.95, y / r.height));
      }
    });
    c.addEventListener('pointerleave', () => { this.zoomPos = null; });
    c.addEventListener('pointerdown', (e) => {
      this.mouseDown = true;
      c.setPointerCapture(e.pointerId);
      const r = this._rect(c);
      if (this.orientation === 'h') this.split = (e.clientX - r.left) / r.width;
      else this.split = (e.clientY - r.top) / r.height;
    });
    const up = () => { this.mouseDown = false; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', () => {
      this.orientation = this.orientation === 'h' ? 'v' : 'h';
    });
  }

  toggleOrientation() {
    this.orientation = this.orientation === 'h' ? 'v' : 'h';
  }

  // 每帧调用
  draw(zoomCanvas) {
    const c = this.canvas, ctx = this.ctx;
    const cssW = c.clientWidth, cssH = c.clientHeight;
    if (cssW < 4) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }

    const panes = this.getPanes();
    if (!panes || !panes[0]) return;
    const p0 = panes[0], p2 = panes[2];

    const drawPaneCover = (pane, dx, dy, dw, dh, src) => {
      // src 为画布绝对坐标 [x,y,w,h]（cover() 已含 pane 偏移）
      ctx.drawImage(this.src, src[0], src[1], src[2], src[3], dx, dy, dw, dh);
    };

    // 计算 cover 映射：pane 与目标同比例（均约 16:9），按目标矩形裁出对应源区域
    const cover = (pane, tw, th) => {
      const pa = pane.w / pane.h, ta = tw / th;
      if (pa > ta) {
        const sw = pane.h * ta;
        return [pane.x + (pane.w - sw) / 2, pane.y, sw, pane.h];
      }
      const sh = pane.w / ta;
      return [pane.x, pane.y + (pane.h - sh) / 2, pane.w, sh];
    };

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();

    const leftPane = this.showBefore ? p2 : p0;
    const rightPane = p2;
    if (this.orientation === 'h') {
      const cut = W * this.split;
      const l = cover(leftPane, cut, H);
      const rr = cover(rightPane, W - cut, H);
      drawPaneCover(leftPane, 0, 0, cut, H, l);
      drawPaneCover(rightPane, cut, 0, W - cut, H, rr);
      ctx.strokeStyle = '#3ea6ff'; ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(cut, 0); ctx.lineTo(cut, H); ctx.stroke();
      // 把手
      ctx.fillStyle = '#3ea6ff';
      ctx.beginPath(); ctx.arc(cut, H / 2, 10 * dpr, 0, Math.PI * 2); ctx.fill();
      this._label(this.showBefore ? '合成' : '原始', 12 * dpr, 14 * dpr);
      this._label('合成', W - 12 * dpr, 14 * dpr, true);
    } else {
      const cut = H * this.split;
      const t = cover(p0, W, cut);
      const b = cover(p2, W, H - cut);
      drawPaneCover(p0, 0, 0, W, cut, t);
      drawPaneCover(p2, 0, cut, W, H - cut, b);
      ctx.strokeStyle = '#3ea6ff'; ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(0, cut); ctx.lineTo(W, cut); ctx.stroke();
      this._label('原始', 12 * dpr, 14 * dpr);
      this._label('合成', W - 12 * dpr, H - 10 * dpr, true);
    }
    ctx.restore();

    if (zoomCanvas) this._drawZoom(zoomCanvas, panes);
  }

  _label(text, x, y, right = false) {
    const ctx = this.ctx;
    ctx.font = `${12 * (window.devicePixelRatio || 1)}px sans-serif`;
    const w = ctx.measureText(text).width + 12 * (window.devicePixelRatio || 1);
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    const bx = right ? x - w : x;
    ctx.fillRect(bx, y - 11 * (window.devicePixelRatio || 1), w, 16 * (window.devicePixelRatio || 1));
    ctx.fillStyle = '#cfe7ff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 6 * (window.devicePixelRatio || 1), y - 2 * (window.devicePixelRatio || 1));
  }

  _drawZoom(zoomCanvas, panes) {
    const zctx = zoomCanvas.getContext('2d');
    const zw = zoomCanvas.width, zh = zoomCanvas.height;
    zctx.fillStyle = '#050505'; zctx.fillRect(0, 0, zw, zh);
    if (!this.zoomPos) {
      zctx.fillStyle = '#3a4250'; zctx.font = '13px sans-serif';
      zctx.fillText('悬停查看边缘细节', 14, zh / 2);
      return;
    }
    const pane = panes[2]; // 放大镜看合成画面边缘
    const mx = this.zoomPos.x / this.zoomPos.w;
    const my = this.zoomPos.y / this.zoomPos.h;
    // 合成 pane 与放大镜目标均接近 16:9，按 cover 映射到 UV
    const pa = pane.w / pane.h;
    const za = zw / zh;
    let cu, cv, visW, visH;
    if (pa > za) { visH = 1; visW = za / pa; cu = (1 - visW) / 2; cv = 0; }
    else { visW = 1; visH = pa / za; cu = 0; cv = (1 - visH) / 2; }
    const u = cu + mx * visW;
    const v = cv + my * visH;
    const zoom = this.zoomLevel;
    const sw = pane.w / zoom, sh = pane.h / zoom;
    const sx = pane.x + u * pane.w - sw / 2;
    const sy = pane.y + v * pane.h - sh / 2;
    zctx.imageSmoothingEnabled = false;
    zctx.drawImage(this.src, sx, sy, sw, sh, 0, 0, zw, zh);
    zctx.strokeStyle = 'rgba(62,166,255,.8)'; zctx.lineWidth = 1;
    zctx.beginPath();
    zctx.moveTo(zw / 2, 0); zctx.lineTo(zw / 2, zh);
    zctx.moveTo(0, zh / 2); zctx.lineTo(zw, zh / 2);
    zctx.stroke();
    zctx.fillStyle = '#9fb4c8'; zctx.font = '10px sans-serif';
    zctx.fillText(`${zoom}× 合成边缘`, 6, zh - 8);
  }
}
