// 色度键共享数学：CPU 回退逐像素处理与对照测试共用的纯函数实现。
// 约定：
//  - 颜色 / alpha / 阈值均使用与 GLSL 着色器相同的 0..1 尺度（纹理归一化值），
//    唯独前背景光照/色彩匹配统计（lightMatchFromStats）统一使用 RGBA8 的 0..255 字节口径；
//  - GLSL 着色器的 RGB/HSV/YUV 权重、羽化、降噪、半透明区间、溢色边缘等系数全部
//    从本文件的导出常量注入，本文件是这些系数的唯一定义处；
//  - smoothstep 在两边界相等（相似度平滑度=0）时按阶跃兜底，GLSL 端必须用同名语义
//    的 ss()，不得依赖内建 smoothstep 的未定义结果；
//  - 每个函数都必须与 js/gl/shaders.js 里的对应 GLSL 片段逐一对齐，
//    修改任一方时必须同步另一方（tests/keying-parity.test.mjs、
//    tests/stats-match-parity.test.mjs 会做常量/公式/量纲对照）。

// RGB 加权色度距离（对应 KEY_FRAG 的 RGB 分支）
export const RGB_WEIGHTS = [1.2, 1.0, 1.2];
export const RGB_SCALE = 0.8;

// HSV 距离权重（对应 KEY_FRAG 的 HSV 分支）
export const HSV_HUE_WEIGHT = 2.2;
export const HSV_SAT_WEIGHT = 0.25;

// YUV 色度平面距离权重
export const YUV_SCALE = 1.8;

// 遮罩精修参数（对应 GLEngine._postMask / POST_MASK_FRAG）
export const FEATHER_SCALE = 0.045;
export const DENOISE_BLEND = 0.55;
export const DENOISE_SNAP = 0.12;
export const SEMI_LOW = 0.18;
export const SEMI_HIGH = 0.82;

// 溢色边缘混合系数（KEY_FRAG / processForeground 中 edgeFactor * edgeColor 的系数）
export const SPILL_EDGE_BLEND = 0.6;
// 绿/蓝溢色补偿系数（抑制通道后向另外两通道的补偿比例）
export const SPILL_COMP_GREEN = 0.12;
export const SPILL_COMP_BLUE = 0.10;

// 前背景光照/色彩匹配统计参数（GLEngine / CPUEngine 共用同一份）
export const EXPOSURE_MIN = 0.5;
export const EXPOSURE_MAX = 2.0;
export const TINT_MIN = 0.6;
export const TINT_MAX = 1.6;
export const MATCH_SMOOTH = 0.5;   // 每 30 帧统计一次，向新系数做 0.5 收敛
export const MATCH_COVERAGE = 12 / 256; // 16×16 回读上 alpha 均值低于此值不更新

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// GLSL smoothstep 的 JS 精确实现（Hermite 3t²−2t³，edge0==edge1 时兜底为阶跃）
export function smoothstep(edge0, edge1, x) {
  const t = edge1 === edge0
    ? (x < edge0 ? 0 : 1)
    : (x - edge0) / (edge1 - edge0);
  const tc = clamp01(t);
  return tc * tc * (3 - 2 * tc);
}

// 与 KEY_FRAG::rgb2yuv 相同：输入/输出均为 0..1
export function rgb2yuv(c) {
  const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const u = -0.168736 * c[0] - 0.331264 * c[1] + 0.5 * c[2] + 0.5;
  const v = 0.5 * c[0] - 0.418688 * c[1] - 0.081312 * c[2] + 0.5;
  return [y, u, v];
}

// 与 KEY_FRAG::rgb2hsv（修正 d==0 后）相同：输入 0..1，输出 [h,s,v] 均 0..1。
// 分支写法与着色器里的 Sam Hocevar 无分支版本对所有输入（含并列最大值）结果一致。
export function rgb2hsv(c) {
  const r = c[0], g = c[1], b = c[2];
  let maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const d = maxc - minc;
  let h;
  if (maxc === r) {
    h = ((g - b) / d) % 6; // d==0 时 NaN，下面统一归零
  } else if (maxc === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  h /= 6;
  if (h < 0) h += 1;
  // 无色度：与着色器 d < 0.5e-6 守卫一致（8-bit 归一化最小非零色差为 1/255，不会误伤）
  if (d < 0.5e-6) h = 0;
  return [h, maxc === 0 ? 0 : d / maxc, maxc];
}

// 色度距离（0..1 尺度），mode: 0 RGB, 1 YUV, 2 HSV —— 对应 keyAlpha() 的距离部分
export function colorDistance(c, key, mode) {
  if (mode === 1) {
    const p = rgb2yuv(c);
    const k = rgb2yuv(key);
    const du = p[1] - k[1];
    const dv = p[2] - k[2];
    return Math.sqrt(du * du + dv * dv) * YUV_SCALE;
  }
  if (mode === 2) {
    const h = rgb2hsv(c);
    const hk = rgb2hsv(key);
    let dh = Math.abs(h[0] - hk[0]);
    dh = Math.min(dh, 1 - dh);
    return dh * HSV_HUE_WEIGHT + Math.max(hk[1] - h[1], 0) * HSV_SAT_WEIGHT;
  }
  const dr = (c[0] - key[0]) * RGB_WEIGHTS[0];
  const dg = (c[1] - key[1]) * RGB_WEIGHTS[1];
  const db = (c[2] - key[2]) * RGB_WEIGHTS[2];
  return Math.sqrt(dr * dr + dg * dg + db * db) * RGB_SCALE;
}

// 色度键前景 alpha：与 KEY_FRAG::keyAlpha 完全一致（smoothstep 而非线性斜坡）
export function keyAlpha(c, key, mode, threshold, smooth) {
  const dist = colorDistance(c, key, mode);
  return smoothstep(threshold - smooth, threshold + smooth, dist);
}

// 与 KEY_FRAG::edgeFactor 相同：alpha=0.5 处为 1，两侧按 smoothstep 衰减
export function edgeFactor(a) {
  return 1 - smoothstep(0, 0.25, Math.abs(a - 0.5) * 2);
}

// 溢色抑制 + 前景调色：与 KEY_FRAG main() 中 keyAlpha 之后的部分逐行对齐。
// 输入 c 为原始 0..1 场景色，a 为键控原始 alpha（形态学之前），输出处理后的 0..1 前景色。
export function processForeground(c, a, params, matchExp, matchTint) {
  let r = c[0], g = c[1], b = c[2];
  const s = params.spill, gr = params.grade;

  // ---------- 溢色抑制（先算强度，再 mix） ----------
  if (s.channel === 'green' || s.channel === 'blue') {
    const green = s.channel === 'green';
    const over = green
      ? Math.max(g - Math.max(r, b), 0)
      : Math.max(b - Math.max(r, g), 0);
    let sr = r, sg = g, sb = b;
    if (green) {
      sg -= over * s.strength;
      sr += over * SPILL_COMP_GREEN * s.strength;
      sb += over * SPILL_COMP_GREEN * s.strength;
    } else {
      sb -= over * s.strength;
      sr += over * SPILL_COMP_BLUE * s.strength;
      sg += over * SPILL_COMP_BLUE * s.strength;
    }
    let wgt = s.strength * (1 - a);
    wgt = Math.min(1, Math.max(0, wgt + edgeFactor(a) * s.edgeColor * SPILL_EDGE_BLEND));
    r = r + (sr - r) * wgt;
    g = g + (sg - g) * wgt;
    b = b + (sb - b) * wgt;
  }

  // ---------- 前景调色 ----------
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
  r = Math.pow(clamp01(r), gamma);
  g = Math.pow(clamp01(g), gamma);
  b = Math.pow(clamp01(b), gamma);

  const link = s.linkGrade ? 0.85 : 1;
  const expMul = gr.lightMatch ? (1 + (matchExp - 1) * link) : 1;
  const tint = params.background.colorMatch ? matchTint : [1, 1, 1];
  r *= expMul * (1 + (tint[0] - 1) * link);
  g *= expMul * (1 + (tint[1] - 1) * link);
  b *= expMul * (1 + (tint[2] - 1) * link);

  return [clamp01(r), clamp01(g), clamp01(b)];
}

// 3×3 形态学（作用于 0..1 alpha）：mode 0=腐蚀(min)，1=膨胀(max)，边界钳制
export function morph3x3(src, w, h, mode) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      let val = src[idx];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.max(0, Math.min(h - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(w - 1, x + dx));
          const v2 = src[yy * w + xx];
          val = mode === 0 ? Math.min(val, v2) : Math.max(val, v2);
        }
      }
      out[idx] = val;
    }
  }
  return out;
}

// 3×3 加权高斯（中心 4、正交 2、对角 1，权重和 16），与 GAUSS_FRAG 一致
export function gauss3x3Alpha(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.max(0, Math.min(h - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(w - 1, x + dx));
          const wt = (dx === 0 || dy === 0) ? ((dx === 0 && dy === 0) ? 4 : 2) : 1;
          sum += src[yy * w + xx] * wt;
        }
      }
      out[y * w + x] = sum / 16;
    }
  }
  return out;
}

// 遮罩精修单像素 alpha 变换（POST_MASK_FRAG 的非纹理取值部分），
// mean 为 3×3 邻域均值，featherW 为 GLEngine 传入的羽化半宽
export function refineAlpha(a, mean, denoise, preserveSemi, featherW) {
  let out = a;
  if (denoise > 0.001) {
    out = out + (mean - out) * denoise * DENOISE_BLEND;
    const snap = denoise * DENOISE_SNAP;
    const isSemi = out > SEMI_LOW && out < SEMI_HIGH;
    if (!(preserveSemi && isSemi)) {
      if (out < snap) out = 0;
      else if (out > 1 - snap) out = 1;
    }
  }
  if (featherW > 0.001) {
    out = smoothstep(0.5 - featherW, 0.5 + featherW, out);
  }
  return clamp01(out);
}

// 前背景光照/色彩匹配统计：GLEngine（16×16 回读）与 CPUEngine（工作分辨率）
// 必须共用同一份口径。输入均为 RGBA8 字节统计量：
//   fg: 前景预乘 RGB 之和 Σ(rgb*a)（0..255 字节尺度）与覆盖度之和 Σa（a 按字节/255）；
//   bg: 背景纹理 RGB 之和（0..255 字节尺度）与取样数；
//   n: 取样像素数（GL=256，CPU=工作分辨率像素数，公式分辨率无关）。
// 覆盖度不足时返回 null（不更新平滑系数）；否则返回 { exp, tint } 目标值（未做平滑）。
export function lightMatchFromStats({ fgRS, fgGS, fgBS, fgAS, bgRS, bgGS, bgBS, n }) {
  if (!(fgAS > n * MATCH_COVERAGE) || n <= 0) return null;
  // 去预乘后的前景/背景均值，统一 0..255 口径（两引擎必须一致）
  const fR = fgRS / fgAS, fG = fgGS / fgAS, fB = fgBS / fgAS;
  const bR = bgRS / n, bG = bgGS / n, bB = bgBS / n;
  const targetExp = (0.299 * bR + 0.587 * bG + 0.114 * bB) /
                    (0.299 * fR + 0.587 * fG + 0.114 * fB + 1);
  const exp = Math.min(EXPOSURE_MAX, Math.max(EXPOSURE_MIN, targetExp));
  const tint = [
    Math.min(TINT_MAX, Math.max(TINT_MIN, bR / (fR + 1))),
    Math.min(TINT_MAX, Math.max(TINT_MIN, bG / (fG + 1))),
    Math.min(TINT_MAX, Math.max(TINT_MIN, bB / (fB + 1))),
  ];
  return { exp, tint };
}

// 系数帧间平滑：两引擎同一份 0.5 收敛
export function applyLightMatch(state, target) {
  state.matchExp += (target.exp - state.matchExp) * MATCH_SMOOTH;
  state.matchTint = state.matchTint.map(
    (v, i) => v + (target.tint[i] - v) * MATCH_SMOOTH);
}
