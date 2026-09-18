// 全局参数模型：UI 与渲染引擎共享的单一数据源

export const DEFAULT_PARAMS = {
  key: {
    color: [0, 0.694, 0.251],  // 背景键色（标准绿幕 #00b140，线性 0..1）
    mode: 'YUV',               // RGB | YUV | HSV
    threshold: 0.38,           // 相似度阈值
    smoothness: 0.12,          // 平滑度
    shrink: 1,                 // 边缘收缩 px
    feather: 1,                // 边缘羽化 px
    outputAlpha: false,        // 合成窗直接输出 alpha 遮罩
  },
  mask: {
    erode: 0,                  // 形态学腐蚀次数
    dilate: 0,                 // 形态学膨胀次数
    blur: 1,                   // 高斯模糊次数（alpha 通道）
    denoise: 0.15,             // 噪点抑制强度
    preserveSemi: true,        // 半透明区域保留
  },
  spill: {
    channel: 'green',          // green | blue | none
    strength: 0.6,             // 溢色抑制强度
    edgeColor: 0.35,           // 边缘颜色校正
    linkGrade: true,           // 与前景调色联动
  },
  background: {
    mode: 'blur',              // solid | image | video | blur
    color: [0.133, 0.267, 0.4],
    scale: 1.0,
    offsetX: 0,
    offsetY: 0,
    loop: true,
    colorMatch: false,         // 前背景基础色彩匹配
  },
  grade: {
    brightness: 0,
    contrast: 0,
    saturation: 1,
    temperature: 0,
    tint: 0,
    curve: 1,                  // gamma
    lightMatch: false,         // 前背景光照统一
  },
  quality: {
    downscale: 0.5,
    autoQuality: false,
  },
};

// 深拷贝默认值
export function createDefaultParams() {
  return structuredClone(DEFAULT_PARAMS);
}

// 内置示例预设（只覆盖参数，不改背景素材）
export const BUILTIN_PRESETS = {
  green: {
    name: '标准绿幕',
    params: {
      key:  { color: [0, 0.694, 0.251], mode: 'YUV', threshold: 0.38, smoothness: 0.12, shrink: 1, feather: 1, outputAlpha: false },
      mask: { erode: 0, dilate: 0, blur: 1, denoise: 0.15, preserveSemi: true },
      spill:{ channel: 'green', strength: 0.6, edgeColor: 0.35, linkGrade: true },
      grade:{ brightness: 0, contrast: 0, saturation: 1, temperature: 0, tint: 0, curve: 1, lightMatch: false },
    },
  },
  blue: {
    name: '蓝幕',
    params: {
      key:  { color: [0.08, 0.25, 0.95], mode: 'YUV', threshold: 0.36, smoothness: 0.13, shrink: 1, feather: 1, outputAlpha: false },
      mask: { erode: 0, dilate: 0, blur: 1, denoise: 0.18, preserveSemi: true },
      spill:{ channel: 'blue', strength: 0.65, edgeColor: 0.4, linkGrade: true },
      grade:{ brightness: 0, contrast: 0.02, saturation: 1.02, temperature: 0, tint: 0, curve: 1, lightMatch: false },
    },
  },
  lowlight: {
    name: '低光照',
    params: {
      key:  { color: [0.05, 0.55, 0.12], mode: 'YUV', threshold: 0.52, smoothness: 0.22, shrink: 0, feather: 2, outputAlpha: false },
      mask: { erode: 0, dilate: 1, blur: 2, denoise: 0.45, preserveSemi: true },
      spill:{ channel: 'green', strength: 0.45, edgeColor: 0.55, linkGrade: true },
      grade:{ brightness: 0.14, contrast: 0.12, saturation: 0.9, temperature: 0.12, tint: 0.03, curve: 0.9, lightMatch: true },
    },
  },
};

// 将外部 JSON（可能是部分参数）合并进完整参数
export function mergeParams(base, incoming) {
  const out = structuredClone(base);
  for (const section of Object.keys(out)) {
    if (incoming[section] && typeof incoming[section] === 'object') {
      Object.assign(out[section], incoming[section]);
    }
  }
  return out;
}

export function paramsToJSON(p) {
  return JSON.stringify({ app: 'GreenRoom', version: 1, params: p }, null, 2);
}
