// CPU 2D Canvas 回退引擎：与 GLEngine 相同的接口，纯 JS 逐像素处理
// 为保证实时性，工作分辨率限制在约 360p 以内
// 色度键 / 形态学 / 模糊 / 精修 / 溢色 / 调色的数学全部来自 js/keying.js，
// 与 js/gl/shaders.js 的 GLSL 实现逐式对齐（仅工作分辨率可更低）
import { paneToUv } from '../layout.js';
import {
  keyAlpha, processForeground, morph3x3, gauss3x3Alpha, refineAlpha,
  clamp01,
  FEATHER_SCALE, lightMatchFromStats, applyLightMatch,
} from '../keying.js';

// RGBA8 纹理边界量化：WebGL 每个 Pass 都写入 UNSIGNED_BYTE，CPU 端在等价位置同样量化
const q8 = (v) => Math.round(clamp01(v) * 255) / 255;
function quantize(a) {
  for (let i = 0; i < a.length; i++) a[i] = q8(a[i]);
  return a;
}

export class CPUEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bgImageEl = null;
    this.bgVideoEl = null;
    this.matchExp = 1; this.matchTint = [1, 1, 1];
    this.frameNo = 0;
    this.gpuMs = null;
    this.histogram = new Array(256).fill(0);
    this.workCanvas = document.createElement('canvas');
    this.wctx = this.workCanvas.getContext('2d', { willReadFrequently: true });
    this.bgCanvas = document.createElement('canvas');
    this.bctx = this.bgCanvas.getContext('2d', { willReadFrequently: true });
  }

  setBgImage(img) { this.bgImageEl = img; }
  clearBgImage() { this.bgImageEl = null; }
  setBgVideoElement(v) { this.bgVideoEl = v; }

  render(video, params, layout) {
    const t0 = performance.now();
    this.frameNo++;
    let passes = 0;

    // 工作分辨率：取视频尺寸 × downscale，长边封顶 480
    const vw = video && video.videoWidth ? video.videoWidth : 640;
    const vh = video && video.videoHeight ? video.videoHeight : 360;
    let w = Math.round(vw * params.quality.downscale);
    let h = Math.round(vh * params.quality.downscale);
    const maxSide = 480;
    if (Math.max(w, h) > maxSide) {
      const k = maxSide / Math.max(w, h);
      w = Math.round(w * k); h = Math.round(h * k);
    }
    this.workW = w; this.workH = h;

    // 1) 采集场景
    this.workCanvas.width = w; this.workCanvas.height = h;
    const ctx = this.wctx;
    if (video && video.videoWidth) {
      ctx.drawImage(video, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#06080c'; ctx.fillRect(0, 0, w, h);
    }
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    passes++;

    // 2) 背景准备（预渲染到工作尺寸，供逐像素索引）
    let bgData = null;
    const bgPre = this._prepareBackground(params, w, h);
    if (bgPre) { bgData = bgPre; passes += 3; }

    // 3) 色度键（逐像素，输出到 0..1 alpha）
    // 距离/斜坡公式与 KEY_FRAG::keyAlpha 完全一致（0..1 尺度、smoothstep）
    const rawAlpha = new Float32Array(w * h);
    const keyColor01 = params.key.color;
    const mode = params.key.mode === 'YUV' ? 1 : params.key.mode === 'HSV' ? 2 : 0;
    for (let p = 0, i = 0; i < d.length; i += 4, p++) {
      const c = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
      rawAlpha[p] = keyAlpha(c, keyColor01, mode,
        params.key.threshold, params.key.smoothness);
    }
    quantize(rawAlpha);
    passes++;

    // 4) 形态学 / 收缩：顺序与 GLEngine 相同 —— erode → dilate → shrink
    let a = rawAlpha;
    for (let i = 0; i < params.mask.erode; i++) { a = quantize(morph3x3(a, w, h, 0)); passes++; }
    for (let i = 0; i < params.mask.dilate; i++) { a = quantize(morph3x3(a, w, h, 1)); passes++; }
    for (let i = 0; i < params.key.shrink; i++) { a = quantize(morph3x3(a, w, h, 0)); passes++; }

    // 5) 3×3 加权高斯作用于 alpha（与 GAUSS_FRAG 同核：4/2/1，权重和 16）
    for (let it = 0; it < params.mask.blur; it++) {
      a = quantize(gauss3x3Alpha(a, w, h)); passes++;
    }

    // 6) 遮罩精修：邻域降噪 / 半透明保留 / smoothstep 羽化（与 POST_MASK_FRAG 一致）
    const featherW = params.key.feather * FEATHER_SCALE;
    const dn = params.mask.denoise;
    const refined = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        let mean = a[idx];
        if (dn > 0.001) {
          let sum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = Math.max(0, Math.min(h - 1, y + dy));
            for (let dx = -1; dx <= 1; dx++) {
              const xx = Math.max(0, Math.min(w - 1, x + dx));
              sum += a[yy * w + xx];
            }
          }
          mean = sum / 9;
        }
        refined[idx] = refineAlpha(a[idx], mean, dn,
          params.mask.preserveSemi, featherW);
      }
    }
    quantize(refined);
    a = refined; passes++;

    // 7) 溢色 + 调色 + 合成（合一处理，公式与 KEY_FRAG 一致）
    const out = ctx.createImageData(w, h);
    const od = out.data;
    const bgc = params.background.color;
    // 每 30 帧统计一次：与 GLEngine._updateStats 完全相同的 0..255 字节口径，
    // 同一公式来自 keying.js（STAT_FRAG 预乘 rgb*a + 覆盖度 a；背景为模糊场景/场景）
    const doStats = this.frameNo % 30 === 0;
    const acc = doStats
      ? { fgRS: 0, fgGS: 0, fgBS: 0, fgAS: 0, bgRS: 0, bgGS: 0, bgBS: 0, n: w * h }
      : null;
    for (let p = 0, i = 0; i < od.length; i += 4, p++) {
      const c0 = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
      // 溢色/调色使用键控原始 alpha（GL 在形态学之前完成溢色），
      // 合成使用精修后的 alpha
      const fg = processForeground(c0, rawAlpha[p], params, this.matchExp, this.matchTint);
      const aa = a[p];
      let r = fg[0] * 255, gg = fg[1] * 255, b = fg[2] * 255;

      if (doStats) {
        // 前景：调色后 RGB 按覆盖度预乘（等价 STAT_FRAG mode0 的 RGBA8 回读）
        acc.fgRS += r * aa; acc.fgGS += gg * aa; acc.fgBS += b * aa; acc.fgAS += aa;
        // 背景：与 GL 相同——blur 取模糊背景，其余取原始场景（不低 alpha 挑样）
        if (bgData) { acc.bgRS += bgData[i]; acc.bgGS += bgData[i + 1]; acc.bgBS += bgData[i + 2]; }
        else { acc.bgRS += d[i]; acc.bgGS += d[i + 1]; acc.bgBS += d[i + 2]; }
      }

      // 背景取样
      let br, bg, bb;
      if (params.key.outputAlpha) {
        od[i] = od[i + 1] = od[i + 2] = aa * 255; od[i + 3] = 255; continue;
      }
      const m = params.background.mode;
      if (m === 'solid') {
        br = bgc[0] * 255; bg = bgc[1] * 255; bb = bgc[2] * 255;
      } else if (m === 'blur' || m === 'image' || m === 'video') {
        if (bgData) { br = bgData[i]; bg = bgData[i + 1]; bb = bgData[i + 2]; }
        else { br = bgc[0] * 255; bg = bgc[1] * 255; bb = bgc[2] * 255; }
      } else {
        br = bgc[0] * 255; bg = bgc[1] * 255; bb = bgc[2] * 255;
      }
      od[i] = r * aa + br * (1 - aa);
      od[i + 1] = gg * aa + bg * (1 - aa);
      od[i + 2] = b * aa + bb * (1 - aa);
      od[i + 3] = 255;
    }
    passes++;

    // 统计：与 GLEngine 同一公式、同一 0..255 口径（CPU 在完整工作分辨率上累计）
    if (doStats) {
      const target = lightMatchFromStats(acc);
      if (target) applyLightMatch(this, target);
    }
    // 直方图（alpha 以 8-bit 分桶，与 GLEngine 回读口径一致）
    if (this.frameNo % 12 === 0) {
      const bins = new Array(256).fill(0);
      for (let i = 0; i < a.length; i++) bins[Math.round(a[i] * 255)]++;
      this.histogram = bins;
    }

    // 三路视口绘制
    const c = this.canvas, gctx = this.ctx;
    c.width = layout.W; c.height = layout.H;
    gctx.fillStyle = '#000'; gctx.fillRect(0, 0, layout.W, layout.H);
    this.maskCanvas = this.maskCanvas || document.createElement('canvas');
    this.maskCanvas.width = w; this.maskCanvas.height = h;
    const mctx = this.maskCanvas.getContext('2d');
    const mimg = mctx.createImageData(w, h);
    for (let i = 0; i < mimg.data.length; i += 4) {
      const v = a[i / 4] * 255;
      mimg.data[i] = mimg.data[i + 1] = mimg.data[i + 2] = v;
      mimg.data[i + 3] = 255;
    }
    mctx.putImageData(mimg, 0, 0);
    this.compCanvas = this.compCanvas || document.createElement('canvas');
    if (this.compCanvas.width !== w || this.compCanvas.height !== h) {
      this.compCanvas.width = w; this.compCanvas.height = h;
    }
    this.compCanvas.getContext('2d').putImageData(out, 0, 0);
    const compCanvas = this.compCanvas;
    this.origCanvas = this.workCanvas;

    const paneAspect = layout.panes[0].w / layout.panes[0].h;
    const drawCover = (src, pane) => {
      const sa = w / h;
      let dw, dh, dx, dy;
      if (sa > paneAspect) { dh = pane.h; dw = dh * sa; dx = pane.x - (dw - pane.w) / 2; dy = pane.y; }
      else { dw = pane.w; dh = dw / sa; dy = pane.y - (dh - pane.h) / 2; dx = pane.x; }
      gctx.drawImage(src, dx, dy, dw, dh);
    };
    for (let i = 0; i < 3; i++) {
      const pn = layout.panes[i];
      gctx.save();
      gctx.beginPath(); gctx.rect(pn.x, pn.y, pn.w, pn.h); gctx.clip();
      if (i === 0) drawCover(this.workCanvas, pn);
      else if (i === 1) drawCover(this.maskCanvas, pn);
      else drawCover(compCanvas, pn);
      gctx.restore();
      if (i < 2) { gctx.strokeStyle = '#222'; gctx.strokeRect(pn.x, pn.y, pn.w, pn.h); }
    }
    passes += 3;

    return {
      cpuMs: performance.now() - t0,
      gpuMs: null,
      passes,
      workW: w, workH: h,
      histogram: this.histogram,
    };
  }

  // 将背景（图片/视频/模糊场景）按 cover + scale + offset 绘制到工作尺寸
  _prepareBackground(params, w, h) {
    const mode = params.background.mode;
    let el = null;
    if (mode === 'image' && this.bgImageEl &&
        (this.bgImageEl.naturalWidth || this.bgImageEl.width)) el = this.bgImageEl;
    if (mode === 'video' && this.bgVideoEl && this.bgVideoEl.videoWidth) el = this.bgVideoEl;

    if (mode === 'blur') {
      // 多级缩小放大制造强模糊
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tc = tmp.getContext('2d');
      tc.imageSmoothingEnabled = true;
      this.bgCanvas.width = Math.max(2, Math.round(w / 10));
      this.bgCanvas.height = Math.max(2, Math.round(h / 10));
      this.bctx.drawImage(this.workCanvas, 0, 0, this.bgCanvas.width, this.bgCanvas.height);
      tc.drawImage(this.bgCanvas, 0, 0, w, h);
      this.bgCanvas.width = Math.max(2, Math.round(w / 5));
      this.bgCanvas.height = Math.max(2, Math.round(h / 5));
      this.bctx.drawImage(tmp, 0, 0, this.bgCanvas.width, this.bgCanvas.height);
      tc.drawImage(this.bgCanvas, 0, 0, w, h);
      return tc.getImageData(0, 0, w, h).data;
    }

    if (!el) return null;
    const ew = el.videoWidth || el.naturalWidth;
    const eh = el.videoHeight || el.naturalHeight;
    this.bgCanvas.width = w; this.bgCanvas.height = h;
    const c = this.bctx;
    c.fillStyle = '#111'; c.fillRect(0, 0, w, h);
    c.imageSmoothingEnabled = true;
    // cover 基准 + scale/offset
    const sa = ew / eh, ta = w / h, scale = params.background.scale;
    let dw, dh;
    if (sa > ta) { dh = h; dw = h * sa; } else { dw = w; dh = w / sa; }
    dw *= scale; dh *= scale;
    const dx = (w - dw) / 2 + params.background.offsetX * w;
    const dy = (h - dh) / 2 + params.background.offsetY * h;
    // 2D drawImage 对图片/视频均按正立绘制，无需翻转
    c.drawImage(el, dx, dy, dw, dh);
    return c.getImageData(0, 0, w, h).data;
  }

  // 前背景光照/色彩统计在 render() 合成循环中累计，公式与口径
  // （lightMatchFromStats / applyLightMatch）与 GLEngine 完全共用 js/keying.js，
  // 本引擎不再保留第二份实现。

  pickOriginal(nx, ny, workAspect, paneAspect) {
    const [u, v] = paneToUv(nx, ny, workAspect, paneAspect);
    const x = Math.max(0, Math.min(this.workW - 1, Math.round(u * this.workW)));
    const y = Math.max(0, Math.min(this.workH - 1, Math.round(v * this.workH)));
    const d = this.wctx.getImageData(x, y, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255];
  }
}
