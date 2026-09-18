// 对照测试：验证 CPU 回退（js/keying.js）与 WebGL（js/gl/shaders.js + GLEngine）
// 在相同参数下抠像公式一致。
//
// 运行：
//   node --test
//   node --test tests/keying-parity.test.mjs
//
// 测试不依赖浏览器/WebGL 上下文，分五部分：
//   A. 逐像素数学：独立移植 GLSL 公式（glslRef），与共享模块 keying.js 逐值对照；
//   B. 静态契约：读取发货的 shader / 引擎源码，断言公式与关键调用没有漂移；
//   C. 整帧管线：合成“模拟绿幕边缘”帧，跑完整 alpha 管线
//      （键控→形态学→高斯→精修），比较两引擎同参数下的遮罩分布；
//   D. 光照/色彩匹配统计：computeLightMatch 锁 0–255 字节量纲，两引擎同源调用；
//   E. 平滑度为 0：shader 的 safeSmoothstep 与 JS 阶跃兜底同一套斜坡。
//
// 常量单一定义源：shaders.js 从 keying.js import 后插值生成，本文件同时断言
// 着色器/引擎源码里不再出现手写的距离/YUV/HSV/羽化/降噪/溢色系数字面量。
//
// 允许 CPU 工作分辨率更低，但公式必须对齐——本测试在同一分辨率上比较数学本身。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RGB_WEIGHTS, RGB_SCALE, HSV_HUE_WEIGHT, HSV_SAT_WEIGHT, YUV_SCALE,
  LUMA_R, LUMA_G, LUMA_B, YUV_U_R, YUV_U_G, YUV_U_B, YUV_V_R, YUV_V_G, YUV_V_B,
  FEATHER_SCALE, DENOISE_BLEND, DENOISE_SNAP, SEMI_LOW, SEMI_HIGH,
  SPILL_GREEN_COMP, SPILL_BLUE_COMP, SPILL_EDGE_GAIN,
  MATCH_EXP_MIN, MATCH_EXP_MAX, MATCH_TINT_MIN, MATCH_TINT_MAX,
  MATCH_EASE, MATCH_ALPHA_GATE, MATCH_EPS,
  smoothstep, clamp, clamp01, rgb2yuv, rgb2hsv, colorDistance, keyAlpha,
  edgeFactor, processForeground, morph3x3, gauss3x3Alpha, refineAlpha,
  computeLightMatch,
} from '../js/keying.js';
import { KEY_FRAG, POST_MASK_FRAG, GAUSS_FRAG } from '../js/gl/shaders.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// shadersRaw 为生成前的模板源码（检查“字面量只来自 keying.js”用它，
// KEY_FRAG/POST_MASK_FRAG 则是 import 进来的编译产物）
const shadersRaw = readFileSync(join(__dirname, '../js/gl/shaders.js'), 'utf8');
const keyingRaw = readFileSync(join(__dirname, '../js/keying.js'), 'utf8');
const glEngineSrc = readFileSync(join(__dirname, '../js/gl/GLEngine.js'), 'utf8');
const cpuEngineSrc = readFileSync(join(__dirname, '../js/cpu/CPUEngine.js'), 'utf8');

/* ===================================================================== *
 * A. 独立 GLSL 移植（只依据 shaders.js 手工翻译，不 import keying.js，
 *    避免“自己证明自己”）
 * ===================================================================== */

// GLSL smoothstep：发货着色器统一用 safeSmoothstep，其 edge0==edge1 分支与
// keying.js::smoothstep 的阶跃兜底逐字对应（GLSL 内建 smoothstep 在等边时未定义，
// smoothness 可拖到 0，这正是两种引擎必须一致的路径）；这里独立直译 safeSmoothstep。
function gl_smoothstep(e0, e1, x) {
  const t = (e1 === e0) ? (x < e0 ? 0 : 1) : (x - e0) / (e1 - e0);
  const tc = Math.min(1, Math.max(0, t));
  return tc * tc * (3 - 2 * tc);
}
const gl_clamp01 = (x) => Math.min(1, Math.max(0, x));

function gl_rgb2yuv(c) {
  const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const u = -0.168736 * c[0] - 0.331264 * c[1] + 0.5 * c[2] + 0.5;
  const v = 0.5 * c[0] - 0.418688 * c[1] - 0.081312 * c[2] + 0.5;
  return [y, u, v];
}

// KEY_FRAG::rgb2hsv 的 Sam Hocevar 无分支写法的 JS 直译（含发货着色器里的守卫）
// 注意 GLSL mix(a, b, step(x,y))：step 为 1（y>=x）时取 b，为 0 时取 a
function gl_rgb2hsv(c) {
  // p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g))
  // K = (0, -1/3, 2/3, -1)：c.bg/K.wz 分支取 (K.w, K.z)=(-1, 2/3)，
  // c.gb/K.xy 分支取 (K.x, K.y)=(0, -1/3)
  const selP = c[1] >= c[2];
  const pa = selP ? c[1] : c[2];            // p.x
  const pb = selP ? c[2] : c[1];            // p.y
  const pz = selP ? 0 : -1;                 // p.z ← K.x 或 K.w
  const pw = selP ? -1 / 3 : 2 / 3;         // p.w ← K.y 或 K.z
  // q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r))
  // mix(a2,b2,selQ)：selQ=1 取 b2=(c.r,p.y,p.z,p.x)，否则 a2=(p.x,p.y,p.w,c.r)
  const selQ = c[0] >= pa;
  const qx = selQ ? c[0] : pa;
  const qy = pb;
  const qz = selQ ? pz : pw;
  const qw = selQ ? pa : c[0];
  const d = qx - Math.min(qw, qy);
  const e = 1e-10;
  let hue = Math.abs(qz + (qw - qy) / (6 * d + e));
  let sat = d / (qx + e);
  if (d < 0.5e-6) { hue = 0; sat = 0; }
  return [hue, sat, qx];
}

function gl_keyAlpha(c, key, mode, threshold, smooth) {
  let dist;
  if (mode === 1) {
    const p = gl_rgb2yuv(c), k = gl_rgb2yuv(key);
    dist = Math.hypot(p[1] - k[1], p[2] - k[2]) * 1.8;
  } else if (mode === 2) {
    const h = gl_rgb2hsv(c), hk = gl_rgb2hsv(key);
    let dh = Math.abs(h[0] - hk[0]);
    dh = Math.min(dh, 1 - dh);
    dist = dh * 2.2 + Math.max(hk[1] - h[1], 0) * 0.25;
  } else {
    const dd = [c[0] - key[0], c[1] - key[1], c[2] - key[2]];
    dist = Math.hypot(dd[0] * 1.2, dd[1] * 1.0, dd[2] * 1.2) * 0.8;
  }
  return gl_clamp01(gl_smoothstep(threshold - smooth, threshold + smooth, dist));
}

function gl_edgeFactor(a) {
  return 1 - gl_smoothstep(0, 0.25, Math.abs(a - 0.5) * 2);
}

// KEY_FRAG main() 中溢色+调色段直译
function gl_processForeground(c, a, params, matchExp, matchTint) {
  let r = c[0], g = c[1], b = c[2];
  const s = params.spill, gr = params.grade;
  if (s.channel === 1 || s.channel === 2) {
    const green = s.channel === 1;
    const over = green ? Math.max(g - Math.max(r, b), 0)
                       : Math.max(b - Math.max(r, g), 0);
    let sr = r, sg = g, sb = b;
    if (green) {
      sg -= over * s.strength;
      sr += over * 0.12 * s.strength;
      sb += over * 0.12 * s.strength;
    } else {
      sb -= over * s.strength;
      sr += over * 0.10 * s.strength;
      sg += over * 0.10 * s.strength;
    }
    let wgt = s.strength * (1 - a);
    wgt = Math.min(1, Math.max(0, wgt + gl_edgeFactor(a) * s.edgeColor * 0.6));
    r = r + (sr - r) * wgt; g = g + (sg - g) * wgt; b = b + (sb - b) * wgt;
  }
  r += gr.temperature * 0.08;
  b -= gr.temperature * 0.08;
  g += gr.tint * 0.08;
  r -= gr.tint * 0.04;
  b -= gr.tint * 0.04;
  r += gr.brightness; g += gr.brightness; b += gr.brightness;
  const cc = 1 + gr.contrast;
  r = (r - 0.5) * cc + 0.5;
  g = (g - 0.5) * cc + 0.5;
  b = (b - 0.5) * cc + 0.5;
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  r = l + (r - l) * gr.saturation;
  g = l + (g - l) * gr.saturation;
  b = l + (b - l) * gr.saturation;
  const gamma = 1 / Math.max(gr.curve, 0.05);
  r = Math.pow(gl_clamp01(r), gamma);
  g = Math.pow(gl_clamp01(g), gamma);
  b = Math.pow(gl_clamp01(b), gamma);
  const link = s.linkGrade ? 0.85 : 1;
  const expMul = gr.lightMatch ? (1 + (matchExp - 1) * link) : 1;
  const tint = params.background.colorMatch ? matchTint : [1, 1, 1];
  r *= expMul * (1 + (tint[0] - 1) * link);
  g *= expMul * (1 + (tint[1] - 1) * link);
  b *= expMul * (1 + (tint[2] - 1) * link);
  return [gl_clamp01(r), gl_clamp01(g), gl_clamp01(b)];
}

// 完整 alpha 管线（MORPH_FRAG / GAUSS_FRAG / POST_MASK_FRAG 直译）
function gl_morph(src, w, h, mode) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let val = src[y * w + x];
    for (let dy = -1; dy <= 1; dy++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy));
      for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx));
        const v2 = src[yy * w + xx];
        val = mode === 0 ? Math.min(val, v2) : Math.max(val, v2);
      }
    }
    out[y * w + x] = val;
  };
  return out;
}
function gl_gauss(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy));
      for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx));
        const wt = (dx === 0 || dy === 0) ? ((dx === 0 && dy === 0) ? 4 : 2) : 1;
        sum += src[yy * w + xx] * wt;
      }
    }
    out[y * w + x] = sum / 16;
  };
  return out;
}
function gl_post(src, w, h, denoise, preserveSemi, featherW) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let av = src[y * w + x];
    if (denoise > 0.001) {
      let mean = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          mean += src[yy * w + xx];
        }
      }
      mean /= 9;
      av = av + (mean - av) * denoise * 0.55;
      const snap = denoise * 0.12;
      const isSemi = av > 0.18 && av < 0.82;
      if (!(preserveSemi && isSemi)) {
        av = av < snap ? 0 : (av > 1 - snap ? 1 : av);
      }
    }
    if (featherW > 0.001) av = gl_smoothstep(0.5 - featherW, 0.5 + featherW, av);
    out[y * w + x] = gl_clamp01(av);
  };
  return out;
}
const q8 = (v) => Math.round(gl_clamp01(v) * 255) / 255;
function gl_quantize(a) { for (let i = 0; i < a.length; i++) a[i] = q8(a[i]); return a; }

/* ===================================================================== *
 * 测试辅助
 * ===================================================================== */

// 8-bit 归一化颜色空间全集（步长 8 → 33³ = 35937 色，覆盖各类边缘）
function quantizedColors(step = 8) {
  const out = [];
  for (let r = 0; r <= 255; r += step)
    for (let g = 0; g <= 255; g += step)
      for (let b = 0; b <= 255; b += step) out.push([r / 255, g / 255, b / 255]);
  return out;
}
const GRID = quantizedColors();
// 关键键色：标准绿幕 / 蓝幕 / 灰 / 红 / 青
const KEYS = [
  [0, 0.694, 0.251], [0.08, 0.25, 0.95], [0.5, 0.5, 0.5],
  [0.9, 0.1, 0.1], [0.1, 0.8, 0.8],
];
const EPS = 1e-6;

function makeParams(over = {}) {
  return {
    key: { color: KEYS[0], mode: 'RGB', threshold: 0.38, smoothness: 0.12,
           shrink: 1, feather: 1, outputAlpha: false, ...(over.key || {}) },
    mask: { erode: 0, dilate: 0, blur: 1, denoise: 0.15,
            preserveSemi: true, ...(over.mask || {}) },
    spill: { channel: 'green', strength: 0.6, edgeColor: 0.35,
             linkGrade: true, ...(over.spill || {}) },
    grade: { brightness: 0, contrast: 0, saturation: 1, temperature: 0,
             tint: 0, curve: 1, lightMatch: false, ...(over.grade || {}) },
    background: { color: [0.133, 0.267, 0.4], colorMatch: false,
                  mode: 'solid', ...(over.background || {}) },
  };
}

/* ===================================================================== *
 * B. 静态契约：发货源码里的公式/常量必须与共享模块一致，且只定义一次
 * ===================================================================== */

test('B1 着色器 RGB 距离：权重 (1.2,1.0,1.2) 且整体 ×0.8（旧 CPU 是 (1.2,1.0,0.8) 且无尺度）', () => {
  // 编译产物（从 keying.js 常量插值生成）里必须是新公式
  assert.match(KEY_FRAG, /d \* vec3\(1\.2,\s*1\.0,\s*1\.2\)\) \* 0\.8/);
  // 生成模板里不得再手写这三个字面量（只能来自 RGB_WEIGHTS / RGB_SCALE 插值）
  assert.doesNotMatch(shadersRaw, /vec3\(1\.2,\s*1\.0,\s*1\.2\)/);
  assert.doesNotMatch(shadersRaw, /\) \* 0\.8;/);
  // CPU 引擎不得再出现旧公式
  assert.doesNotMatch(cpuEngineSrc, /\(b - keyColor\[2\]\) \* 0\.8/);
  assert.deepEqual(RGB_WEIGHTS, [1.2, 1.0, 1.2]);
  assert.equal(RGB_SCALE, 0.8);
});

test('B2 三个模式的距离常量在 GLSL / 共享模块中一致，且 GLSL 数值来自 keying.js', () => {
  assert.match(KEY_FRAG, /distance\(pu, ku\) \* 1\.8/);
  assert.match(KEY_FRAG, /dh \* 2\.2 \+ max\(hk\.y - h\.y, 0\.0\) \* 0\.25/);
  // 模板源码不得手写 1.8 / 2.2 / 0.25 距离系数
  assert.doesNotMatch(shadersRaw, /distance\(pu, ku\) \* 1\.8/);
  assert.doesNotMatch(shadersRaw, /dh \* 2\.2/);
  assert.doesNotMatch(shadersRaw, /\) \* 0\.25;/);
  assert.equal(YUV_SCALE, 1.8);
  assert.equal(HSV_HUE_WEIGHT, 2.2);
  assert.equal(HSV_SAT_WEIGHT, 0.25);
});

test('B2b YUV/rgb2yuv 与亮度系数来自同一份定义（不再两份字面量）', () => {
  // 编译产物数值不变
  assert.match(KEY_FRAG, /float u = -0\.168736\*c\.r - 0\.331264\*c\.g \+ 0\.5\*c\.b \+ 0\.5;/);
  assert.match(KEY_FRAG, /float v = 0\.5\*c\.r - 0\.418688\*c\.g - 0\.081312\*c\.b \+ 0\.5;/);
  assert.match(KEY_FRAG, /dot\(c, vec3\(0\.299, 0\.587, 0\.114\)\)/);
  // 模板里只能以插值符号出现（0.299/0.587/0.114 均不得为字面量）
  assert.doesNotMatch(shadersRaw, /0\.168736/);
  assert.doesNotMatch(shadersRaw, /0\.331264/);
  assert.doesNotMatch(shadersRaw, /0\.418688/);
  assert.doesNotMatch(shadersRaw, /0\.081312/);
  assert.doesNotMatch(shadersRaw, /0\.299/);
  assert.doesNotMatch(shadersRaw, /0\.587/);
  assert.doesNotMatch(shadersRaw, /0\.114/);
  assert.equal(YUV_U_R, -0.168736);
  assert.equal(YUV_U_G, -0.331264);
  assert.equal(YUV_U_B, 0.5);
  assert.equal(YUV_V_R, 0.5);
  assert.equal(YUV_V_G, -0.418688);
  assert.equal(YUV_V_B, -0.081312);
  assert.deepEqual([LUMA_R, LUMA_G, LUMA_B], [0.299, 0.587, 0.114]);
});

test('B3 键控斜坡：两引擎同走 safeSmoothstep（CPU 旧实现是线性 clamp），等边为阶跃', () => {
  assert.match(KEY_FRAG, /safeSmoothstep\(uThreshold - uSmooth, uThreshold \+ uSmooth, dist\)/);
  assert.match(cpuEngineSrc, /keyAlpha\(/);
  assert.doesNotMatch(cpuEngineSrc, /\(dist - \(t - sm\)\) \/ \(2 \* sm\)/);
  // 着色器键控/羽化斜坡不得再直接调用内建 smoothstep（等边时未定义）
  assert.doesNotMatch(KEY_FRAG, /[^a-zA-Z]smoothstep\(/);
  assert.doesNotMatch(POST_MASK_FRAG, /[^a-zA-Z]smoothstep\(/);
  assert.match(KEY_FRAG, /float safeSmoothstep\(float e0, float e1, float x\)/);
  assert.match(POST_MASK_FRAG, /float safeSmoothstep\(float e0, float e1, float x\)/);
});

test('B4 精修参数契约：feather*0.045、snap=0.12、semi=0.18/0.82、blend=0.55，均单一定义', () => {
  // 引擎羽化半宽统一取自 FEATHER_SCALE，不再各写 *0.045
  assert.match(glEngineSrc, /uFeatherW', params\.key\.feather \* FEATHER_SCALE\)/);
  assert.match(cpuEngineSrc, /params\.key\.feather \* FEATHER_SCALE/);
  assert.doesNotMatch(glEngineSrc, /feather \* 0\.045/);
  assert.doesNotMatch(cpuEngineSrc, /feather \* 0\.045/);
  // 编译产物（生成自共享常量）
  assert.match(POST_MASK_FRAG, /uDenoise \* 0\.55/);
  assert.match(POST_MASK_FRAG, /float snap = uDenoise \* 0\.12;/);
  assert.match(POST_MASK_FRAG, /a > 0\.18 && a < 0\.82/);
  // 模板里不得手写这些字面量
  assert.doesNotMatch(shadersRaw, /uDenoise \* 0\.55/);
  assert.doesNotMatch(shadersRaw, /uDenoise \* 0\.12/);
  assert.doesNotMatch(shadersRaw, /a > 0\.18/);
  assert.equal(FEATHER_SCALE, 0.045);
  assert.equal(DENOISE_BLEND, 0.55);
  assert.equal(DENOISE_SNAP, 0.12);
  assert.equal(SEMI_LOW, 0.18);
  assert.equal(SEMI_HIGH, 0.82);
  // CPU 不得残留旧的 0..255 口径
  assert.doesNotMatch(cpuEngineSrc, /feather \* 11/);
  assert.doesNotMatch(cpuEngineSrc, /dn \* 30/);
});

test('B4b 溢色边缘/补偿系数来自同一份定义（0.12 绿补、0.10 蓝补、0.6 边缘增益）', () => {
  assert.match(KEY_FRAG, /suppressed\.rb \+= gx \* 0\.12 \* uSpillStrength;/);
  assert.match(KEY_FRAG, /suppressed\.rg \+= bx \* 0\.1 \* uSpillStrength;/);
  const edgeGainLines = KEY_FRAG.match(/wgt = clamp\(wgt \+ edgeFactor\(a\) \* uEdgeColor \* 0\.6/g) || [];
  assert.equal(edgeGainLines.length, 2);
  // 模板里不得手写
  assert.doesNotMatch(shadersRaw, /gx \* 0\.12/);
  assert.doesNotMatch(shadersRaw, /bx \* 0\.1/);
  assert.doesNotMatch(shadersRaw, /uEdgeColor \* 0\.6/);
  assert.equal(SPILL_GREEN_COMP, 0.12);
  assert.equal(SPILL_BLUE_COMP, 0.1);
  assert.equal(SPILL_EDGE_GAIN, 0.6);
});

test('B5 alpha 模糊：CPU 使用与 GAUSS_FRAG 相同的 4/2/1 加权核（旧为盒式模糊）', () => {
  assert.match(GAUSS_FRAG, /\(x == 0 \|\| y == 0\) \? \(x == 0 && y == 0 \? 4\.0 : 2\.0\) : 1\.0/);
  assert.match(cpuEngineSrc, /gauss3x3Alpha/);
  assert.doesNotMatch(cpuEngineSrc, /_boxBlurAlpha/);
});

test('B6 形态学顺序：两引擎都是 erode → dilate → shrink', () => {
  const glOrder = glEngineSrc.indexOf("params.mask.erode") < glEngineSrc.indexOf("params.mask.dilate")
    && glEngineSrc.indexOf("params.mask.dilate") < glEngineSrc.indexOf("params.key.shrink");
  assert.ok(glOrder);
  const cpuOrder = cpuEngineSrc.indexOf("params.mask.erode") < cpuEngineSrc.indexOf("params.mask.dilate")
    && cpuEngineSrc.indexOf("params.mask.dilate") < cpuEngineSrc.indexOf("params.key.shrink");
  assert.ok(cpuOrder);
});

test('B7 溢色边缘曲线 edgeFactor 与调色 tint 系数对齐（旧 CPU B 通道多了 -tint*20）', () => {
  assert.match(cpuEngineSrc, /processForeground\(c0, rawAlpha\[p\]/);
  // tint 在 R/B 上分别是 -0.04/-0.04（旧 CPU 为 -10/-20 的 0..255 写法，即 -0.039/-0.079）
  assert.match(KEY_FRAG, /c\.r -= uTint \* 0\.04;\s*c\.b -= uTint \* 0\.04;/);
  assert.doesNotMatch(cpuEngineSrc, /g\.tint \* 20/);
});

test('B8 HSV 守卫：着色器与共享模块都对无色度像素将 hue/sat 归零', () => {
  assert.match(KEY_FRAG, /if \(d < 0\.5e-6\) \{ hue = 0\.0; sat = 0\.0; \}/);
  // 守卫缺失时，灰/白/黑在 epsilon 除法下产生数量级异常的色相项
  // （d/(6d+e) 可达 1e5～1e10）；守卫后距离必须是有限且 <=2.45 的正常量。
  // 无色度像素色相按 0 处理：对绿色键距离=|0-0.3936|*2.2+0.25≈1.116（判定为前景），
  // 对红色键距离仅 0.25（低饱和近背景），行为可预期、两引擎一致。
  for (const gray of [[0, 0, 0], [0.5, 0.5, 0.5], [1, 1, 1]]) {
    const dGreen = colorDistance(gray, KEYS[0], 2);
    assert.ok(Number.isFinite(dGreen) && dGreen < 2.5,
      `无色度像素距离异常: ${gray} → ${dGreen}`);
    // 对纯红键（hue=0）：灰像素 hue 项为 0，仅剩饱和度惩罚 0.25
    const redKey = [0.9, 0.1, 0.1];
    assert.ok(Math.abs(colorDistance(gray, redKey, 2) - rgb2hsv(redKey)[1] * 0.25) < EPS);
  }
});

/* ===================================================================== *
 * A. 逐像素数学对照
 * ===================================================================== */

test('A1 smoothstep 与 GLSL 定义一致（Hermite，端点与中点）', () => {
  for (const [e0, e1, x, want] of [
    [0.3, 0.5, 0.3, 0], [0.3, 0.5, 0.5, 1], [0.3, 0.5, 0.4, 0.5],
    [0.3, 0.5, 0.2, 0], [0.3, 0.5, 0.7, 1],
  ]) {
    assert.ok(Math.abs(smoothstep(e0, e1, x) - want) < EPS);
    assert.ok(Math.abs(smoothstep(e0, e1, x) - gl_smoothstep(e0, e1, x)) < EPS);
  }
});

test('A2 rgb2yuv 在 8-bit 网格上与 GLSL 移植一致', () => {
  let maxErr = 0;
  for (const c of GRID) {
    const a = rgb2yuv(c), b = gl_rgb2yuv(c);
    for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(a[k] - b[k]));
  }
  assert.ok(maxErr < EPS, `maxErr=${maxErr}`);
});

test('A3 rgb2hsv 在 8-bit 网格上与 GLSL 无分支移植一致（含并列最大值）', () => {
  let maxErr = 0, bad = null;
  for (const c of GRID) {
    const a = rgb2hsv(c), b = gl_rgb2hsv(c);
    for (let k = 0; k < 3; k++) {
      const e = Math.abs(a[k] - b[k]);
      if (e > maxErr) { maxErr = e; bad = [c, a, b]; }
    }
  }
  assert.ok(maxErr < EPS, `maxErr=${maxErr}, sample=${JSON.stringify(bad)}`);
  // 几个显式并列用例：黄(R=G>B)、青(G=B>R)、品红(R=B>G)、灰
  for (const c of [[1, 1, 0.2], [0.2, 1, 1], [1, 0.2, 1], [0.4, 0.4, 0.4]]) {
    const a = rgb2hsv(c), b = gl_rgb2hsv(c);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(a[k] - b[k]) < EPS);
  }
});

for (const [modeName, mode] of [['RGB', 0], ['YUV', 1], ['HSV', 2]]) {
  // GLSL 三个距离分支的独立 JS 直译
  const glDist = (c, key) => {
    if (mode === 1) {
      const p = gl_rgb2yuv(c), k = gl_rgb2yuv(key);
      return Math.hypot(p[1] - k[1], p[2] - k[2]) * 1.8;
    }
    if (mode === 2) {
      const h = gl_rgb2hsv(c), hk = gl_rgb2hsv(key);
      let dh = Math.abs(h[0] - hk[0]);
      dh = Math.min(dh, 1 - dh);
      return dh * 2.2 + Math.max(hk[1] - h[1], 0) * 0.25;
    }
    const dd = [c[0] - key[0], c[1] - key[1], c[2] - key[2]];
    return Math.hypot(dd[0] * 1.2, dd[1] * 1.0, dd[2] * 1.2) * 0.8;
  };

  test(`A4/${modeName} colorDistance 在网格×多键色上与 GLSL 一致`, () => {
    let maxErr = 0;
    for (const key of KEYS)
      for (const c of GRID)
        maxErr = Math.max(maxErr, Math.abs(colorDistance(c, key, mode) - glDist(c, key)));
    assert.ok(maxErr < EPS, `${modeName} maxErr=${maxErr}`);
  });

  test(`A5/${modeName} keyAlpha 斜坡在网格×阈值扫描上与 GLSL smoothstep 一致`, () => {
    const key = KEYS[0];
    let maxErr = 0;
    for (const th of [0.15, 0.38, 0.6]) {
      for (const sm of [0.03, 0.12, 0.25]) {
        for (const c of GRID) {
          maxErr = Math.max(maxErr,
            Math.abs(keyAlpha(c, key, mode, th, sm) - gl_keyAlpha(c, key, mode, th, sm)));
        }
      }
    }
    assert.ok(maxErr < EPS, `${modeName} maxErr=${maxErr}`);
  });
}

test('A6 edgeFactor 与 KEY_FRAG 一致（0.5→1，0/1→0）', () => {
  for (let i = 0; i <= 100; i++) {
    const a = i / 100;
    assert.ok(Math.abs(edgeFactor(a) - gl_edgeFactor(a)) < EPS);
  }
  assert.equal(edgeFactor(0.5), 1);
  assert.equal(edgeFactor(0), 0);
  assert.equal(edgeFactor(1), 0);
});

test('A7 processForeground（溢色+调色）在多组参数下与 GLSL 移植一致', () => {
  const variants = [
    makeParams(),
    makeParams({
      spill: { channel: 'green', strength: 0.9, edgeColor: 0.6 },
      grade: { temperature: 0.3, tint: -0.2, brightness: 0.1, contrast: 0.2,
               saturation: 1.3, curve: 0.8, lightMatch: true },
      background: { colorMatch: true },
    }),
    makeParams({ spill: { channel: 'blue', strength: 0.65, edgeColor: 0.4 } }),
    makeParams({ spill: { channel: 'none' }, grade: { saturation: 0.5 } }),
  ];
  const alphaSamples = [0, 0.1, 0.5, 0.9, 1];
  let maxErr = 0;
  for (const p of variants) {
    const spMode = p.spill.channel === 'green' ? 1 : p.spill.channel === 'blue' ? 2 : 0;
    const glP = structuredClone(p); glP.spill = { ...p.spill, channel: spMode };
    for (const c of GRID.filter((_, i) => i % 97 === 0)) { // 抽样加速
      for (const av of alphaSamples) {
        const a = processForeground(c, av, p, 1.3, [1.1, 0.95, 1.05]);
        const b = gl_processForeground(c, av, glP, 1.3, [1.1, 0.95, 1.05]);
        for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(a[k] - b[k]));
      }
    }
  }
  assert.ok(maxErr < EPS, `maxErr=${maxErr}`);
});

/* ===================================================================== *
 * C. 整帧 alpha 管线对照（合成模拟绿幕帧）
 * ===================================================================== */

// 生成一帧带噪点和倾斜软边缘的绿幕：左下背景(绿)→右上前景(肤色/发色)，
// 边缘附近是抗锯齿混合色 + 随机噪声，专门考验遮罩边缘与“抠干净程度”
function makeGreenScreenFrame(w, h, rng) {
  const frame = new Array(w * h);
  const green = [0.02, 0.72, 0.28];
  const skin = [0.78, 0.55, 0.42];
  const hair = [0.12, 0.07, 0.04];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // 软分界线：斜线 + 正弦扰动
    const edge = (x / w) * 0.9 + 0.15 + Math.sin(y / h * Math.PI * 3) * 0.08;
    const t = y / h;
    let fg;
    if (t > 0.55) fg = hair; else fg = skin;
    let m = gl_smoothstep(edge - 0.06, edge + 0.06, t);
    // 绿幕布亮度不均 + 噪声
    const n = (rng() - 0.5) * 0.08;
    const shade = 0.85 + 0.3 * (x / w);
    const bg = [green[0] * shade + n, green[1] * shade + n, green[2] * shade + n];
    frame[y * w + x] = [
      gl_clamp01(fg[0] * m + bg[0] * (1 - m)),
      gl_clamp01(fg[1] * m + bg[1] * (1 - m)),
      gl_clamp01(fg[2] * m + bg[2] * (1 - m)),
    ];
  }
  return frame;
}

// mulberry32 确定性伪随机
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runAlphaPipeline(frame, w, h, p, impl) {
  const mode = p.key.mode === 'YUV' ? 1 : p.key.mode === 'HSV' ? 2 : 0;
  const K = impl === 'gl'
    ? { key: gl_keyAlpha, morph: gl_morph, gauss: gl_gauss }
    : {
        key: (c, key, m, th, sm) => keyAlpha(c, key, m, th, sm),
        morph: morph3x3, gauss: gauss3x3Alpha,
      };
  let a = new Float32Array(w * h);
  for (let i = 0; i < frame.length; i++) {
    a[i] = K.key(frame[i], p.key.color, mode, p.key.threshold, p.key.smoothness);
  }
  gl_quantize(a);
  for (let i = 0; i < p.mask.erode; i++) gl_quantize(a = K.morph(a, w, h, 0));
  for (let i = 0; i < p.mask.dilate; i++) gl_quantize(a = K.morph(a, w, h, 1));
  for (let i = 0; i < p.key.shrink; i++) gl_quantize(a = K.morph(a, w, h, 0));
  for (let i = 0; i < p.mask.blur; i++) gl_quantize(a = K.gauss(a, w, h));
  const fw = p.key.feather * 0.045;
  if (impl === 'gl') {
    a = gl_post(a, w, h, p.mask.denoise, p.mask.preserveSemi, fw);
  } else {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      let mean = a[idx];
      if (p.mask.denoise > 0.001) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            sum += a[yy * w + xx];
          }
        }
        mean = sum / 9;
      }
      out[idx] = refineAlpha(a[idx], mean, p.mask.denoise,
        p.mask.preserveSemi, fw);
    }
    a = out;
  }
  gl_quantize(a);
  return a;
}

const W = 64, H = 36;
const FRAME = makeGreenScreenFrame(W, H, rng(20240517));

const pipelineCases = [
  ['RGB 默认', makeParams({ key: { mode: 'RGB' } })],
  ['RGB 紧阈值低平滑', makeParams({ key: { mode: 'RGB', threshold: 0.30, smoothness: 0.05 } })],
  ['RGB 宽阈值 + 强降噪', makeParams({
    key: { mode: 'RGB', threshold: 0.45, smoothness: 0.2 },
    mask: { erode: 1, dilate: 1, blur: 2, denoise: 0.4, preserveSemi: false },
  })],
  ['YUV 默认', makeParams({ key: { mode: 'YUV' } })],
  ['YUV 低光照型参数', makeParams({
    key: { mode: 'YUV', threshold: 0.52, smoothness: 0.22, shrink: 0, feather: 2 },
    mask: { erode: 0, dilate: 1, blur: 2, denoise: 0.45 },
  })],
  ['HSV 默认', makeParams({ key: { mode: 'HSV' } })],
  ['HSV 小阈值', makeParams({ key: { mode: 'HSV', threshold: 0.25, smoothness: 0.08 } })],
];

for (const [name, p] of pipelineCases) {
  test(`C/${name}：整帧遮罩 GLSL 移植 vs CPU 共享实现（逐像素 ≤1 LSB）`, () => {
    const ga = runAlphaPipeline(FRAME, W, H, p, 'gl');
    const ca = runAlphaPipeline(FRAME, W, H, p, 'cpu');
    let maxErr = 0, sumErr = 0, nDiff = 0;
    for (let i = 0; i < ga.length; i++) {
      const e = Math.abs(ga[i] - ca[i]);
      maxErr = Math.max(maxErr, e);
      sumErr += e;
      if (e > 0) nDiff++;
    }
    const meanErr = sumErr / ga.length;
    assert.ok(maxErr <= 1 / 255 + EPS,
      `${name} maxErr=${(maxErr * 255).toFixed(2)} LSB`);
    assert.ok(meanErr < 0.2 / 255,
      `${name} meanErr=${(meanErr * 255).toFixed(3)} LSB`);
    assert.ok(nDiff / ga.length < 0.05,
      `${name} 有差异像素占比 ${(nDiff / ga.length * 100).toFixed(1)}%`);
  });
}

test('C/回归演示：修复前 RGB 旧 CPU 公式与对齐后公式存在系统性偏差', () => {
  // 旧 CPU：权重 (1.2,1.0,0.8)、无 ×0.8、255 尺度、线性斜坡
  const p = makeParams({ key: { mode: 'RGB' } });
  const oldCpuAlpha = (c) => {
    const key = p.key.color.map((v) => v * 255);
    const cc = c.map((v) => v * 255);
    const dist = Math.hypot((cc[0] - key[0]) * 1.2,
                            (cc[1] - key[1]),
                            (cc[2] - key[2]) * 0.8);
    const t = p.key.threshold * 255, sm = p.key.smoothness * 255;
    return clamp01((dist - (t - sm)) / (2 * sm));
  };

  // 1) 8-bit 颜色网格上 |旧alpha − 新alpha| > 0.2 的像素占可观比例
  //    （smoothstep 在远离斜坡处把距离差压成相同的 0/1，故统计的是受影响的过渡带）
  let diffPixels = 0;
  for (const c of GRID) {
    const ref = gl_keyAlpha(c, p.key.color, 0, p.key.threshold, p.key.smoothness);
    if (Math.abs(ref - oldCpuAlpha(c)) > 0.2) diffPixels++;
  }
  const frac = diffPixels / GRID.length;
  assert.ok(frac > 0.08,
    `旧公式与对齐后公式差异像素仅 ${(frac * 100).toFixed(1)}%（网格），回归演示不成立`);

  // 2) 具体用例：肤色这类 RGB 三通道都偏离键色的前景，旧公式因缺少 ×0.8 尺度，
  //    距离比新公式大约 23%（old/new≈1.23）——阈值相同时旧 CPU 更难抠干净
  const c = [0.78, 0.55, 0.42]; // 肤色
  const newDist = colorDistance(c, p.key.color, 0);
  const oldDist = Math.hypot(
    (c[0] - p.key.color[0]) * 1.2,
    (c[1] - p.key.color[1]),
    (c[2] - p.key.color[2]) * 0.8);
  assert.ok(oldDist > newDist * 1.2,
    `肤色距离未体现尺度差异: new=${newDist.toFixed(3)} old=${oldDist.toFixed(3)}`);

  // 3) 斜坡形状：阈值中点两公式都为 0.5，但 smoothstep 与线性斜坡在 1/4、3/4 处分叉
  const mid = p.key.threshold;
  const at = (dist) => ({
    neu: gl_keyAlpha(
      // 构造一个 R 通道恰好给出该距离的颜色（G/B 与键色相同）
      [p.key.color[0] + dist / (1.2 * 0.8), p.key.color[1], p.key.color[2]],
      p.key.color, 0, mid, p.key.smoothness),
    old: clamp01((dist * 255 - (mid - p.key.smoothness) * 255) /
                (2 * p.key.smoothness * 255)),
  });
  const q1 = at(mid - p.key.smoothness / 2);
  assert.ok(Math.abs(q1.neu - 0.15625) < 1e-6); // smoothstep(0.25)=0.15625
  assert.ok(Math.abs(q1.old - 0.25) < 1e-6);    // 线性 = 0.25
});

/* ===================================================================== *
 * D. 前背景光照/色彩匹配统计：两引擎同一 0–255 字节口径、同一函数
 * ===================================================================== */

// 按 GL STAT_FRAG/UNSIGNED_BYTE 回读口径构造 n 个像素的累加：
//   rS 每像素 += round(meanByte · coverage)   （预乘 rgb 字节，gl_FragColor=rgb*a）
//   aS 每像素 += round(coverage · 255)
// computeLightMatch 再 ×255，条件均值回到 meanByte 量纲。
function byteAccumFromMeans(fgMean, fgCoverage /* 平均 alpha 0..1 */, n) {
  const acc = { rS: 0, gS: 0, bS: 0, aS: 0 };
  for (let i = 0; i < n; i++) {
    acc.rS += Math.round(fgMean[0] * fgCoverage);
    acc.gS += Math.round(fgMean[1] * fgCoverage);
    acc.bS += Math.round(fgMean[2] * fgCoverage);
    acc.aS += Math.round(fgCoverage * 255);
  }
  return acc;
}

test('D1 computeLightMatch 在 0–255 字节口径上给出正确曝光/色调（不再被夹到上限）', () => {
  const n = 256;
  // 前景暗（~76 字节）、背景亮（~204 字节）：期望曝光≈2.7 → 夹到 2；
  // 前景亮（~204）、背景暗（~76）：期望曝光≈0.375 → 夹到 0.5。
  // 关键：中等差距（fg=140, bg=170）时必须落在区间内部，
  // 旧实现因 fg 被除成 0–1（≈0.55）而 bg 仍是 170，曝光恒为 2。
  const prev = { exp: 1, tint: [1, 1, 1] };
  const mid = computeLightMatch(
    byteAccumFromMeans([140, 140, 140], 1, n), { r: 170, g: 170, b: 170 }, n, prev);
  // 首帧 EASE=0.5：exp = 1 + (target-1)*0.5
  const targetMid = clamp(170 / (140 + MATCH_EPS), MATCH_EXP_MIN, MATCH_EXP_MAX);
  assert.ok(Math.abs(mid.exp - (1 + (targetMid - 1) * 0.5)) < 1e-9);
  assert.ok(mid.exp > 1 && mid.exp < MATCH_EXP_MAX, `中等差距曝光落在区间内: ${mid.exp}`);

  // 暗前景 / 亮背景 → 目标曝光夹到 2，平滑后 1.5
  const up = computeLightMatch(
    byteAccumFromMeans([76, 76, 76], 1, n), { r: 204, g: 204, b: 204 }, n, prev);
  assert.ok(Math.abs(up.exp - 1.5) < 1e-9, `暗前景亮背景: ${up.exp}`);

  // 通道色调：背景 (200,120,60)，前景 (100,120,200) → R 增益>1、B 增益<1，
  // 字节口径比值才可能落在 [0.6,1.6] 内部；混口径时所有通道都会顶到 1.6。
  const tinted = computeLightMatch(
    byteAccumFromMeans([100, 120, 200], 1, n), { r: 200, g: 120, b: 60 }, n, prev);
  assert.ok(tinted.tint[0] > 1 && tinted.tint[0] < MATCH_TINT_MAX, `R 色调: ${tinted.tint[0]}`);
  assert.ok(tinted.tint[2] < 1 && tinted.tint[2] > MATCH_TINT_MIN, `B 色调: ${tinted.tint[2]}`);
  // G 通道前后景相等 → 目标 1.0（仅允许字节量化造成的极小误差）
  assert.ok(Math.abs(tinted.tint[1] - 1) < 0.01, `G 色调: ${tinted.tint[1]}`);
});

test('D2 覆盖度不足 / 空样本时不更新系数（两引擎同一闸门）', () => {
  const prev = { exp: 1.23, tint: [0.9, 1.1, 1.05] };
  // 平均覆盖度低于 MATCH_ALPHA_GATE（12/255）
  const low = computeLightMatch(
    byteAccumFromMeans([200, 200, 200], 4 / 255, 256),
    { r: 50, g: 50, b: 50 }, 256, prev);
  assert.equal(low.exp, prev.exp);
  assert.deepEqual(low.tint, prev.tint);
  // 空样本
  const empty = computeLightMatch({ rS: 0, gS: 0, bS: 0, aS: 0 },
    { r: 0, g: 0, b: 0 }, 0, prev);
  assert.equal(empty.exp, prev.exp);
  assert.deepEqual(empty.tint, prev.tint);
});

test('D3 回归演示：旧混口径（fg 0–1 / bg 0–255）下曝光恒被夹到上限', () => {
  // 复刻修复前两引擎的公式：fR = Σ(rgb*a)/Σa 在 GL 回读上是 0..1 比值
  // （字节和/字节和，最大值≈1），而 bR = Σbg/n 仍是 0..255。
  const oldBuggy = (fgMean01, bgMean255) => {
    const fY = 0.299 * fgMean01[0] + 0.587 * fgMean01[1] + 0.114 * fgMean01[2];
    const bY = 0.299 * bgMean255[0] + 0.587 * bgMean255[1] + 0.114 * bgMean255[2];
    return Math.min(2, Math.max(0.5, bY / (fY + 1)));
  };
  // 任意“前景略暗于背景”的正常画面，旧公式都给出 2（fY+1 在 1~2 量级，bY 却是 ~100+）
  assert.equal(oldBuggy([0.55, 0.55, 0.55], [170, 170, 170]), 2);
  // 正确字节口径下同一画面目标曝光≈1.2，处于区间内部
  const fixed = clamp(170 / (0.55 * 255 + MATCH_EPS), MATCH_EXP_MIN, MATCH_EXP_MAX);
  assert.ok(fixed > 1 && fixed < 2, `正确口径曝光: ${fixed}`);
});

test('D4 两引擎都调用 computeLightMatch，且不再内联手写统计公式/夹取常量', () => {
  for (const src of [glEngineSrc, cpuEngineSrc]) {
    assert.match(src, /computeLightMatch/);
    // 旧实现的内联夹取与 +1 除零项必须消失
    assert.doesNotMatch(src, /Math\.min\(2,\s*Math\.max\(0\.5/);
    assert.doesNotMatch(src, /Math\.min\(1\.6,\s*Math\.max\(0\.6/);
  }
  // CPU 旧的混口径累加（/255 后再除）必须消失
  assert.doesNotMatch(cpuEngineSrc, /\* aw \/ 255/);
  // CPU 新累加与 GL STAT_FRAG(rgb*a)+字节回读等价：round(fg·alpha*255) + round(alpha*255)
  assert.match(cpuEngineSrc,
    /statAcc\.rS \+= Math\.round\(clamp01\(fg\[0\]\) \* clamp01\(aa\) \* 255\)/);
  assert.match(cpuEngineSrc, /statAcc\.aS \+= Math\.round\(clamp01\(aa\) \* 255\)/);
  // GL 直接累加回读字节（Uint8Array 取值），不做归一化
  assert.match(glEngineSrc, /acc\.rS \+= fgBuf\[i\]/);
  // 统计夹取常量只允许在 keying.js 里以 MATCH_* 常量 + clamp 定义，
  // 引擎源码不得再出现内联的 0.299*bR 统计公式
  assert.match(keyingRaw, /clamp\(bY \/ \(fY \+ MATCH_EPS\), MATCH_EXP_MIN, MATCH_EXP_MAX\)/);
  assert.doesNotMatch(glEngineSrc, /\(0\.299 \* bR/);
  assert.doesNotMatch(cpuEngineSrc, /\(0\.299 \* bR/);
  assert.equal(MATCH_EXP_MIN, 0.5);
  assert.equal(MATCH_EXP_MAX, 2.0);
  assert.equal(MATCH_TINT_MIN, 0.6);
  assert.equal(MATCH_TINT_MAX, 1.6);
  assert.equal(MATCH_EASE, 0.5);
  assert.equal(MATCH_ALPHA_GATE, 12);
  assert.equal(MATCH_EPS, 1);
});

/* ===================================================================== *
 * E. 平滑度为 0：GLSL safeSmoothstep 与 JS 阶跃兜底是同一段斜坡
 * ===================================================================== */

test('E1 smoothstep 等边（smooth=0）时 JS 实现与 GLSL safeSmoothstep 同为阶跃', () => {
  const e = 0.38;
  // 边界点：JS/着色器都是 x < edge → 0，否则 1（GLSL 用 x < e0 ? 0.0 : 1.0）
  for (const x of [0, 0.1, 0.37999, e, 0.38001, 0.9, 1]) {
    const want = x < e ? 0 : 1;
    assert.equal(smoothstep(e, e, x), want, `JS smoothstep(${x})`);
    assert.equal(gl_smoothstep(e, e, x), want, `GLSL ref smoothstep(${x})`);
  }
  // 非等边路径仍是 Hermite，两种实现一致（回归保护）
  for (const x of [0.2, 0.3, 0.4, 0.5, 0.6]) {
    assert.ok(Math.abs(smoothstep(0.3, 0.5, x) - gl_smoothstep(0.3, 0.5, x)) < EPS);
  }
});

for (const [modeName, mode] of [['RGB', 0], ['YUV', 1], ['HSV', 2]]) {
  test(`E2/${modeName} smoothness=0 时 keyAlpha 是阈值阶跃，两引擎一致`, () => {
    const key = KEYS[0];
    const th = 0.38;
    let bad = 0;
    for (const c of GRID) {
      const dist = colorDistance(c, key, mode);
      const cpu = keyAlpha(c, key, mode, th, 0);
      const ref = gl_keyAlpha(c, key, mode, th, 0);
      // 阶跃定义：dist < th → 0；dist >= th → 1（与 GLSL safeSmoothstep 同分支）
      const want = dist < th ? 0 : 1;
      if (cpu !== want || ref !== want) bad++;
    }
    assert.equal(bad, 0, `${modeName} smooth=0 阶跃不一致像素数: ${bad}`);
  });
}

test('E3 着色器键控/羽化斜坡在边界相等时走显式阶跃，不依赖未定义的内建 smoothstep', () => {
  const branch = /\(e1 == e0\) \? \(x < e0 \? 0\.0 : 1\.0\) : \(x - e0\) \/ \(e1 - e0\)/;
  assert.match(KEY_FRAG, branch);
  assert.match(POST_MASK_FRAG, branch);
  // JS 侧同一分支
  assert.match(keyingRaw, /edge1 === edge0\s*\?\s*\(x < edge0 \? 0 : 1\)/);
});

test('E4 整帧管线 smoothness=0：遮罩在两引擎下逐像素一致（无未定义跳变）', () => {
  const p = makeParams({ key: { smoothness: 0 } });
  const ga = runAlphaPipeline(FRAME, W, H, p, 'gl');
  const ca = runAlphaPipeline(FRAME, W, H, p, 'cpu');
  let maxErr = 0;
  for (let i = 0; i < ga.length; i++) maxErr = Math.max(maxErr, Math.abs(ga[i] - ca[i]));
  assert.ok(maxErr <= 1 / 255 + EPS, `smooth=0 maxErr=${(maxErr * 255).toFixed(2)} LSB`);
});

