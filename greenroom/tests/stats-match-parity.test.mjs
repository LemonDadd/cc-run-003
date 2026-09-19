// 对照测试（第二轮修复）：
//   1. 前背景光照/色彩匹配统计的量纲——两个引擎都必须是 0..255 字节口径，
//      曝光/tint 由 js/keying.js 的同一份公式计算（旧实现：GL/CPU 前景均值 0..1、
//      背景 0..255，曝光恒被夹到 2.0、tint 恒饱和，切换引擎亮度对不上）；
//   2. 平滑度为 0 时遮罩斜坡——GLSL 内建 smoothstep 边界相等时未定义，
//      发货着色器必须改用 ss() 阶跃兜底，与 js/keying.js 的 smoothstep 同一套；
//   3. RGB 权重 / YUV / HSV / 羽化 / 降噪 / 半透明 / 溢色边缘等系数
//      只能来自 js/keying.js 这一处定义，着色器不得再手写第二份字面量。
//
// 运行：node --test tests/stats-match-parity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RGB_WEIGHTS, RGB_SCALE, YUV_SCALE, HSV_HUE_WEIGHT, HSV_SAT_WEIGHT,
  FEATHER_SCALE, DENOISE_BLEND, DENOISE_SNAP, SEMI_LOW, SEMI_HIGH,
  SPILL_EDGE_BLEND, SPILL_COMP_GREEN, SPILL_COMP_BLUE,
  EXPOSURE_MIN, EXPOSURE_MAX, TINT_MIN, TINT_MAX, MATCH_SMOOTH,
  MATCH_COVERAGE,
  lightMatchFromStats, applyLightMatch, smoothstep, keyAlpha,
} from '../js/keying.js';
import { KEY_FRAG, POST_MASK_FRAG } from '../js/gl/shaders.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shadersSrc = readFileSync(join(__dirname, '../js/gl/shaders.js'), 'utf8');
const glEngineSrc = readFileSync(join(__dirname, '../js/gl/GLEngine.js'), 'utf8');
const cpuEngineSrc = readFileSync(join(__dirname, '../js/cpu/CPUEngine.js'), 'utf8');

// 编译后着色器（模板已展开）里抽取 ss() 定义体，直译回 JS 验证其阶跃语义
function extractSsFn(src) {
  const m = src.match(/float ss\(float e0, float e1, float x\) \{[\s\S]*?\n\}/);
  assert.ok(m, '发货着色器缺少 ss() 安全 smoothstep 定义');
  return m[0];
}

/* ===================================================================== *
 * 1. 统计量纲：0..255 字节口径 + 单一公式
 * ===================================================================== */

// 构造一份像素数据（RGBA8，alpha 为字节），分别按两个引擎的累计方式
// （GL: 16×16=256 个回读像素；CPU: 全工作分辨率）返回累计量。
function accumulate(pixels) {
  let fgRS = 0, fgGS = 0, fgBS = 0, fgAS = 0;
  let bgRS = 0, bgGS = 0, bgBS = 0;
  for (const px of pixels) {
    const a = px[3] / 255;
    fgRS += px[0] * a; fgGS += px[1] * a; fgBS += px[2] * a; fgAS += a;
    bgRS += px[4]; bgGS += px[5]; bgBS += px[6];
  }
  return { fgRS, fgGS, fgBS, fgAS, bgRS, bgGS, bgBS, n: pixels.length };
}

test('S1 统计口径为 0..255：前/背景等亮时曝光≈1、tint≈1（旧 0..1 口径会夹到 2.0/1.6）', () => {
  // 全部完全覆盖的前景像素，前景与背景同为中性灰 128
  const px = { fg: [128, 128, 128, 255], bg: [128, 128, 128] };
  const acc = accumulate(Array.from({ length: 256 }, () => [...px.fg, ...px.bg]));
  const t = lightMatchFromStats(acc);
  assert.ok(t, '覆盖度足够时应给出系数');
  assert.ok(Math.abs(t.exp - 1) < 0.02, `等亮曝光应≈1，实际 ${t.exp}`);
  // b/(f+1) 在 f=b=128 时为 128/129≈0.992
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(t.tint[k] - 128 / 129) < 0.01,
      `等亮 tint[${k}] 应≈0.992，实际 ${t.tint[k]}`);
  }
});

test('S2 背景比前景亮 4 倍：曝光朝亮处补偿且不被量纲错误夹死', () => {
  // 前景中性灰 64，背景中性灰 255（完全覆盖），曝光目标 ≈ 255/(64+1)≈3.92 → 夹到上限 2.0；
  // 关键是旧口径下前景均值仅 64/255≈0.25，曝光 ≈ 1.0/0.251 ≈ 3.98 也夹到 2 ——
  // 区分两种口径用“温和差”用例：fg=120, bg=180。
  const acc = accumulate(Array.from({ length: 256 }, () => [120, 120, 120, 255, 180, 180, 180]));
  const t = lightMatchFromStats(acc);
  // 0..255 正确口径：180/(120+1)≈1.488；旧 0..1 口径：0.706/(0.471+1)≈0.48 → 夹 0.5，反向压暗
  assert.ok(Math.abs(t.exp - 180 / 121) < 0.02, `exp=${t.exp}`);
  assert.ok(t.exp > 1 && t.exp < EXPOSURE_MAX, '温和亮度差不应触发任何一侧夹断');
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(t.tint[k] - 180 / 121) < 0.02, `tint[${k}]=${t.tint[k]}`);
    assert.ok(t.tint[k] > TINT_MIN && t.tint[k] < TINT_MAX);
  }
});

test('S3 前景比背景亮：曝光低于 1（旧口径下比值被压到 0.5 下限，永远饱和）', () => {
  const acc = accumulate(Array.from({ length: 256 }, () => [200, 200, 200, 255, 90, 90, 90]));
  const t = lightMatchFromStats(acc);
  // 正确口径 90/201≈0.448 → 夹 0.5；旧口径 0.353/(0.784+1)=0.198 也夹 0.5，
  // 故选一个不会被夹的中间值验证口径：fg=150,bg=100 → 100/151≈0.662（>0.5 不夹）
  const acc2 = accumulate(Array.from({ length: 256 }, () => [150, 150, 150, 255, 100, 100, 100]));
  const t2 = lightMatchFromStats(acc2);
  assert.ok(Math.abs(t2.exp - 100 / 151) < 0.02, `exp=${t2.exp}`);
  assert.ok(t2.exp < 1 && t2.exp > EXPOSURE_MIN);
  void t;
});

test('S4 覆盖度门槛：alpha 均值低于 12/256 时不更新（两引擎同阈值）', () => {
  // 256 像素里仅 8 个完全不透明：均值 8/256≈0.03125 < 12/256≈0.0469
  const pixels = Array.from({ length: 256 }, (_, i) =>
    i < 8 ? [100, 100, 100, 255, 200, 200, 200] : [200, 200, 200, 0, 200, 200, 200]);
  assert.equal(lightMatchFromStats(accumulate(pixels)), null);
  // 提到 16 个即越过门槛
  const pixels2 = pixels.map((p, i) => i < 16 ? [100, 100, 100, 255, 200, 200, 200] : p);
  assert.ok(lightMatchFromStats(accumulate(pixels2)));
  assert.equal(MATCH_COVERAGE, 12 / 256);
});

test('S5 公式分辨率无关：同一（归一化）画面在 16×16 与 640×360 上结果完全相同（CPU 可更低分辨率）', () => {
  // 分段常量画面：右半完全不透明前景（恒定色），左半空（alpha=0），背景全屏恒定。
  // 偶数宽保证两分辨率下覆盖像素占比严格 0.5，排除画面离散化干扰。
  const make = (w, h) => {
    const out = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const fg = x >= w / 2;
      out.push(fg ? [110, 80, 60, 255, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0]);
      out[out.length - 1][4] = 150; out[out.length - 1][5] = 170; out[out.length - 1][6] = 210;
    }
    return out;
  };
  const t16 = lightMatchFromStats(accumulate(make(16, 16)));
  const tBig = lightMatchFromStats(accumulate(make(640, 360)));
  assert.ok(Math.abs(t16.exp - tBig.exp) < 1e-12, `exp ${t16.exp} vs ${tBig.exp}`);
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(t16.tint[k] - tBig.tint[k]) < 1e-12);
  }
});

test('S6 帧间平滑：两个引擎都用 applyLightMatch 的 0.5 收敛', () => {
  const state = { matchExp: 1, matchTint: [1, 1, 1] };
  applyLightMatch(state, { exp: 1.8, tint: [1.2, 0.8, 1.1] });
  assert.ok(Math.abs(state.matchExp - 1.4) < 1e-12);
  assert.deepEqual(state.matchTint.map((v) => Math.round(v * 1e9) / 1e9),
    [1.1, 0.9, 1.05]);
  assert.equal(MATCH_SMOOTH, 0.5);
  // 两个引擎源码都不得再内联第二份 0.5 收敛 / 夹断公式
  assert.match(glEngineSrc, /applyLightMatch\(this, target\)/);
  assert.match(cpuEngineSrc, /applyLightMatch\(this, target\)/);
  assert.doesNotMatch(glEngineSrc, /this\.matchExp \+= \(exp/);
  assert.doesNotMatch(cpuEngineSrc, /this\.matchExp \+= \(exp/);
});

test('S7 夹断边界常量单一来源且生效', () => {
  assert.equal(EXPOSURE_MIN, 0.5);
  assert.equal(EXPOSURE_MAX, 2.0);
  assert.equal(TINT_MIN, 0.6);
  assert.equal(TINT_MAX, 1.6);
  // 极端比值确实被夹
  const bright = accumulate(Array.from({ length: 256 }, () => [5, 5, 5, 255, 255, 255, 255]));
  assert.equal(lightMatchFromStats(bright).exp, 2.0);
  const dark = accumulate(Array.from({ length: 256 }, () => [255, 255, 255, 255, 1, 1, 1]));
  assert.equal(lightMatchFromStats(dark).exp, 0.5);
});

test('S8 两个引擎都以 0..255 字节累计：源码静态契约', () => {
  // GL：回读 UNSIGNED_BYTE，覆盖度必须按 /255 归一（旧代码把字节 alpha 直接当权重，
  // 量纲比 CPU 大 255 倍，仅靠 n*12 的字节门槛凑对）
  assert.match(glEngineSrc, /fgAS \+= fgBuf\[i \+ 3\] \/ 255/);
  assert.match(glEngineSrc, /lightMatchFromStats\(\{/);
  assert.doesNotMatch(glEngineSrc, /Math\.min\(2, Math\.max\(0\.5, targetExp\)\)/);
  assert.doesNotMatch(glEngineSrc, /Math\.min\(1\.6, Math\.max\(0\.6/);
  // CPU：前景预乘和背景累计都用字节，不得再 /255 归一成 0..1
  assert.match(cpuEngineSrc, /acc\.fgRS \+= r \* aa; acc\.fgGS \+= gg \* aa; acc\.fgBS \+= b \* aa; acc\.fgAS \+= aa;/);
  assert.doesNotMatch(cpuEngineSrc, /\* aw \/ 255/);
  assert.doesNotMatch(cpuEngineSrc, /_updateStats\(a, d, od/);
});

/* ===================================================================== *
 * 2. smoothness = 0：着色器阶跃斜坡
 * ===================================================================== */

test('Z1 发货 KEY_FRAG 用 ss() 且不含内建 smoothstep 调用', () => {
  assert.match(KEY_FRAG, /ss\(uThreshold - uSmooth, uThreshold \+ uSmooth, dist\)/);
  // KEY_FRAG 内不允许任何内建 smoothstep（edgeFactor 也必须走 ss）
  const noBuiltin = KEY_FRAG.replace(/float ss\([\s\S]*?\n\}/, '');
  assert.doesNotMatch(noBuiltin, /\bsmoothstep\s*\(/);
});

test('Z2 发货 POST_MASK_FRAG 羽化斜坡也走 ss()', () => {
  assert.match(POST_MASK_FRAG, /ss\(0\.5 - uFeatherW, 0\.5 \+ uFeatherW, a\)/);
  assert.doesNotMatch(POST_MASK_FRAG.replace(/float ss\([\s\S]*?\n\}/, ''), /\bsmoothstep\s*\(/);
});

test('Z3 着色器 ss() 直译：edge0==edge1 时 x<edge 为 0、否则为 1，绝不产生 NaN', () => {
  const body = extractSsFn(KEY_FRAG);
  // 必须含边界相等的三元兜底（与 keying.js smoothstep 同一形式）
  assert.match(body, /e0 == e1 \? \(x < e0 \? 0\.0 : 1\.0\)/);
  // 直译 ss() 本体做数值验证
  const gl_ss = (e0, e1, x) => {
    const t = e0 === e1 ? (x < e0 ? 0 : 1) : (x - e0) / (e1 - e0);
    const tc = Math.min(1, Math.max(0, t));
    return tc * tc * (3 - 2 * tc);
  };
  for (const th of [0.1, 0.38, 0.5, 0.9]) {
    for (let i = 0; i <= 200; i++) {
      const dist = i / 200;
      const want = dist < th ? 0 : 1;
      assert.equal(gl_ss(th, th, dist), want);
      assert.equal(smoothstep(th, th, dist), want);
    }
  }
});

test('Z4 keyAlpha smooth=0 整遮罩是阈值阶跃且两引擎一致（距离恰等于阈值时落在前景侧=1）', () => {
  const key = [0, 0.694, 0.251];
  // 构造一组与键色距离连续变化的颜色（R 通道偏移），验证只在阈值处跳变
  for (const mode of [0, 1, 2]) {
    for (const th of [0.2, 0.38, 0.6]) {
      let prev = null, jumps = 0;
      for (let i = 0; i <= 400; i++) {
        const c = [Math.min(1, key[0] + i * 0.004), key[1], key[2]];
        const a = keyAlpha(c, key, mode, th, 0);
        assert.ok(a === 0 || a === 1, `smooth=0 alpha 必须是 0/1，实际 ${a}`);
        if (prev !== null && a !== prev) jumps++;
        prev = a;
      }
      assert.ok(jumps <= 1, `mode=${mode} th=${th} 阶跃次数 ${jumps}（应至多 1）`);
    }
  }
});

test('Z5 smooth=0 与极小 smooth（滑杆下限 0.01）在阈值远处一致，斜坡收敛为同位置阶跃', () => {
  const key = [0, 0.694, 0.251];
  const th = 0.38;
  for (let i = 0; i <= 400; i++) {
    const dist = i / 400;
    // R 通道偏移给出精确 RGB 距离 dist
    const c = [Math.min(1, key[0] + dist / (RGB_WEIGHTS[0] * RGB_SCALE)), key[1], key[2]];
    const a0 = keyAlpha(c, key, 0, th, 0);
    const aTiny = keyAlpha(c, key, 0, th, 0.01);
    if (Math.abs(dist - th) > 0.02) {
      assert.ok(Math.abs(a0 - aTiny) < 1e-9,
        `dist=${dist} 阶跃外不一致 ${a0} vs ${aTiny}`);
    }
  }
});

/* ===================================================================== *
 * 3. 常量单一来源：shaders.js 只能从 keying.js 注入
 * ===================================================================== */

const CONSTANT_CASES = [
  ['RGB_WEIGHTS', RGB_WEIGHTS.map(String), ['1.2', '1.0', '1.2']],
  ['RGB_SCALE', [String(RGB_SCALE)], ['0.8']],
  ['YUV_SCALE', [String(YUV_SCALE)], ['1.8']],
  ['HSV_HUE_WEIGHT', [String(HSV_HUE_WEIGHT)], ['2.2']],
  ['HSV_SAT_WEIGHT', [String(HSV_SAT_WEIGHT)], ['0.25']],
  ['FEATHER_SCALE', [String(FEATHER_SCALE)], ['0.045']],
  ['DENOISE_BLEND', [String(DENOISE_BLEND)], ['0.55']],
  ['DENOISE_SNAP', [String(DENOISE_SNAP)], ['0.12']],
  ['SEMI_LOW', [String(SEMI_LOW)], ['0.18']],
  ['SEMI_HIGH', [String(SEMI_HIGH)], ['0.82']],
  ['SPILL_EDGE_BLEND', [String(SPILL_EDGE_BLEND)], ['0.6']],
  ['SPILL_COMP_GREEN', [String(SPILL_COMP_GREEN)], ['0.12']],
  ['SPILL_COMP_BLUE', [String(SPILL_COMP_BLUE)], ['0.1']],
];

test('K1 shaders.js 从 keying.js 导入全部系数，且源码内不再手写数值字面量', () => {
  // 导入块必须存在
  assert.match(shadersSrc, /import \{[\s\S]*?\} from '\.\.\/keying\.js';/);
  for (const [name] of CONSTANT_CASES) {
    assert.match(shadersSrc, new RegExp(`\\b${name}\\b`),
      `shaders.js 未引用 keying.js 的 ${name}`);
  }
  // 数值不得作为 GLSL 字面量出现在模板里。检查 raw 模板中
  // “数字紧邻在 GLSL 代码上下文”的写法（注入点是 ${fnum(...)} / ${V3(...)}）。
  const banned = [
    /vec3\(1\.2,\s*1\.0,\s*1\.2\)/,   // RGB 权重
    /\) \* 0\.8;/,                     // RGB 尺度（dist = ...）
    /ku\) \* 1\.8/,                    // YUV
    /dh \* 2\.2/,                      // HSV hue
    /hk\.y - h\.y, 0\.0\) \* 0\.25/,   // HSV sat（注意 uBgColor*0.25 出界色不在此列）
    /uDenoise \* 0\.55/,
    /uDenoise \* 0\.12/,
    /a > 0\.18 && a < 0\.82/,
    /uEdgeColor \* 0\.6/,
    /gx \* 0\.12/,
    /bx \* 0\.10/,
  ];
  for (const re of banned) {
    assert.doesNotMatch(shadersSrc, re, `着色器模板残留手写字面量: ${re}`);
  }
});

test('K2 编译后着色器展开值与 keying.js 常量一致（注入真的生效）', () => {
  assert.match(KEY_FRAG, /length\(d \* vec3\(1\.2, 1\.0, 1\.2\)\) \* 0\.8/);
  assert.match(KEY_FRAG, /distance\(pu, ku\) \* 1\.8/);
  assert.match(KEY_FRAG, /dh \* 2\.2 \+ max\(hk\.y - h\.y, 0\.0\) \* 0\.25/);
  assert.match(KEY_FRAG, /uEdgeColor \* 0\.6/);
  assert.match(KEY_FRAG, /gx \* 0\.12 \* uSpillStrength/);
  assert.match(KEY_FRAG, /bx \* 0\.1 \* uSpillStrength/);
  assert.match(POST_MASK_FRAG, /uDenoise \* 0\.55/);
  assert.match(POST_MASK_FRAG, /float snap = uDenoise \* 0\.12;/);
  assert.match(POST_MASK_FRAG, /a > 0\.18 && a < 0\.82/);
});

test('K3 两个引擎的羽化半宽都取自 FEATHER_SCALE，不再各写 0.045', () => {
  assert.match(glEngineSrc, /params\.key\.feather \* FEATHER_SCALE/);
  assert.match(cpuEngineSrc, /params\.key\.feather \* FEATHER_SCALE/);
  assert.match(glEngineSrc, /import \{[^}]*FEATHER_SCALE[^}]*lightMatchFromStats[^}]*\} from '\.\.\/keying\.js'/);
  assert.match(cpuEngineSrc, /import \{[^}]*FEATHER_SCALE, lightMatchFromStats, applyLightMatch/);
});

test('K4 常量清单值本身锁定（防止 keying.js 被误改）', () => {
  assert.deepEqual(RGB_WEIGHTS, [1.2, 1.0, 1.2]);
  assert.deepEqual(
    {
      RGB_SCALE, YUV_SCALE, HSV_HUE_WEIGHT, HSV_SAT_WEIGHT, FEATHER_SCALE,
      DENOISE_BLEND, DENOISE_SNAP, SEMI_LOW, SEMI_HIGH,
      SPILL_EDGE_BLEND, SPILL_COMP_GREEN, SPILL_COMP_BLUE,
    },
    {
      RGB_SCALE: 0.8, YUV_SCALE: 1.8, HSV_HUE_WEIGHT: 2.2, HSV_SAT_WEIGHT: 0.25,
      FEATHER_SCALE: 0.045, DENOISE_BLEND: 0.55, DENOISE_SNAP: 0.12,
      SEMI_LOW: 0.18, SEMI_HIGH: 0.82,
      SPILL_EDGE_BLEND: 0.6, SPILL_COMP_GREEN: 0.12, SPILL_COMP_BLUE: 0.1,
    });
});
