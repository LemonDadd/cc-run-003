// CPUEngine 整帧冒烟测试：用最小 canvas/DOM 桩跑完整 render()，
// 验证键控→形态学→模糊→精修→合成的集成路径不依赖浏览器也能跑通。
// node --test tests/cpu-engine.smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeImageData {
  constructor(w, h) {
    this.width = w; this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
}
class FakeCtx {
  constructor(canvas) { this.canvas = canvas; this.imageSmoothingEnabled = true; }
  fillRect() {}
  drawImage(src, x, y, w, h) {
    // 用渐变假视频填充，确保边缘有过渡色
    const data = this.canvas._data;
    const W = this.canvas.width, H = this.canvas.height;
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
      const i = (yy * W + xx) * 4;
      data[i] = 30 + xx * 4; data[i + 1] = 120 + yy * 3; data[i + 2] = 60; data[i + 3] = 255;
    }
    void src; void x; void y; void w; void h;
  }
  createImageData(w, h) { return new FakeImageData(w, h); }
  getImageData(x, y, w, h) {
    const out = new FakeImageData(w, h);
    const src = this.canvas._data;
    for (let i = 0; i < out.data.length; i++) out.data[i] = src[i] || 0;
    void x; void y;
    return out;
  }
  putImageData(img) { this.canvas._data = img.data; }
  save() {} restore() {} beginPath() {} rect() {} clip() {} strokeRect() {}
  set fillStyle(_) {} get fillStyle() { return ''; }
  set strokeStyle(_) {} get strokeStyle() { return ''; }
}
class FakeCanvas {
  constructor(w = 2, h = 2) {
    this.width = w; this.height = h;
    this._data = new Uint8ClampedArray(w * h * 4);
  }
  getContext() { return new FakeCtx(this); }
}

globalThis.document = { createElement: () => new FakeCanvas() };
globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1e3 };

const { CPUEngine } = await import('../js/cpu/CPUEngine.js');
const { createDefaultParams } = await import('../js/params.js');
const { computeTripleLayout } = await import('../js/layout.js');

const fakeVideo = { videoWidth: 320, videoHeight: 180 };
const layout = computeTripleLayout(960, 360, 1);

function renderFrame(mode, over = {}) {
  const engine = new CPUEngine(new FakeCanvas(320, 180));
  const params = createDefaultParams();
  params.key.mode = mode;
  Object.assign(params.key, over.key || {});
  Object.assign(params.mask, over.mask || {});
  params.spill.channel = mode === 'HSV' && over.blue ? 'blue' : params.spill.channel;
  const metrics = engine.render(fakeVideo, params, layout);
  return { engine, params, metrics };
}

for (const mode of ['RGB', 'YUV', 'HSV']) {
  test(`CPU render(${mode}) 全管线可运行并产出 0..255 合法帧`, () => {
    const { engine, metrics } = renderFrame(mode);
    assert.ok(metrics.workW > 0 && metrics.workH > 0);
    const data = engine.compCanvas.getContext().getImageData(0, 0, metrics.workW, metrics.workH).data;
    let minV = 255, maxV = 0, finite = true;
    for (let i = 0; i < data.length; i += 4) {
      for (let k = 0; k < 4; k++) {
        const v = data[i + k];
        if (!Number.isFinite(v) || v < 0 || v > 255) finite = false;
        minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      }
    }
    assert.ok(finite, '输出含越界/非有限值');
    assert.ok(maxV > minV, '输出不是平帧');
  });
}

test('CPU RGB：切换阈值会单调改变被抠除像素数量', () => {
  const countBg = (over) => {
    const { engine } = renderFrame('RGB', over);
    // 用 outputAlpha 直接数遮罩背景像素
    const e2 = new CPUEngine(new FakeCanvas(320, 180));
    const params = createDefaultParams();
    params.key.mode = 'RGB';
    Object.assign(params.key, over.key || {}, { outputAlpha: true });
    e2.render(fakeVideo, params, layout);
    const m = e2.compCanvas.getContext().getImageData(0, 0, e2.workW, e2.workH).data;
    let bg = 0;
    for (let i = 0; i < m.length; i += 4) if (m[i] < 32) bg++;
    return bg;
  };
  const tight = countBg({ key: { threshold: 0.2 } });
  const loose = countBg({ key: { threshold: 0.6 } });
  assert.ok(loose > tight, `阈值放宽后背景像素应增多: ${tight} -> ${loose}`);
});

test('CPU 输出 alpha 模式：遮罩值与最终合成一致使用同一精修 alpha', () => {
  const engine = new CPUEngine(new FakeCanvas(320, 180));
  const params = createDefaultParams();
  params.key.mode = 'RGB';
  params.key.outputAlpha = true;
  engine.render(fakeVideo, params, layout);
  const data = engine.compCanvas.getContext().getImageData(0, 0, engine.workW, engine.workH).data;
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(data[i], data[i + 1]);
    assert.equal(data[i + 1], data[i + 2]);
    assert.equal(data[i + 3], 255);
  }
});

test('CPU 光照/色彩统计：连续帧后系数有限且落在未被夹死的区间（0–255 口径）', () => {
  const engine = new CPUEngine(new FakeCanvas(320, 180));
  const params = createDefaultParams();
  params.grade.lightMatch = true;
  params.background.colorMatch = true;
  // 第 30 帧触发统计，渲染足够多帧覆盖多次更新
  for (let f = 0; f < 65; f++) engine.render(fakeVideo, params, layout);
  assert.ok(Number.isFinite(engine.matchExp), 'matchExp 非有限');
  assert.ok(engine.matchExp >= 0.5 && engine.matchExp <= 2.0,
    `matchExp 越界: ${engine.matchExp}`);
  for (const t of engine.matchTint) {
    assert.ok(Number.isFinite(t));
    assert.ok(t >= 0.6 && t <= 1.6, `tint 越界: ${t}`);
  }
  // 该渐变帧前景（R 偏高）与模糊背景确有亮度差，系数必须真正离开初值 1
  // （旧混口径会恒顶到 2.0；这里只要证明在更新即可）
  assert.ok(Math.abs(engine.matchExp - 1) > 1e-6, `matchExp 未更新: ${engine.matchExp}`);
});

test('CPU smoothness=0 + 无模糊/降噪/羽化：遮罩严格二值（阶跃，无未定义斜坡）', () => {
  const engine = new CPUEngine(new FakeCanvas(320, 180));
  const params = createDefaultParams();
  params.key.mode = 'RGB';
  params.key.smoothness = 0;
  params.key.shrink = 0;
  params.key.feather = 0;
  params.mask.blur = 0;
  params.mask.denoise = 0;
  params.key.outputAlpha = true;
  engine.render(fakeVideo, params, layout);
  const m = engine.compCanvas.getContext().getImageData(0, 0, engine.workW, engine.workH).data;
  const values = new Set();
  for (let i = 0; i < m.length; i += 4) {
    assert.equal(m[i], m[i + 1]);
    assert.equal(m[i + 1], m[i + 2]);
    values.add(m[i]);
  }
  for (const v of values) assert.ok(v === 0 || v === 255, `出现非二值遮罩值: ${v}`);
});
