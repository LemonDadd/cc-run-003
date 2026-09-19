import { createDefaultParams, BUILTIN_PRESETS, mergeParams, paramsToJSON } from './params.js';
import { savePreset, loadAllPresets, deletePreset } from './db.js';
import { SourceManager } from './source.js';
import { GLEngine, isWebGLAvailable } from './gl/GLEngine.js';
import { CPUEngine } from './cpu/CPUEngine.js';
import { computeTripleLayout } from './layout.js';
import { CompareView } from './ui/compare.js';
import { drawHistogram } from './ui/histogram.js';

// ---------- 状态 ----------
const params = createDefaultParams();
let engineKind = 'webgl';
let engine = null;
let layout = null;
let eyedropperOn = false;
let bgVideoEl = null;

const $ = (id) => document.getElementById(id);
const video = document.createElement('video');
video.muted = true; video.playsInline = true; video.loop = true; video.crossOrigin = 'anonymous';
video.className = 'hidden-video';
document.body.appendChild(video);
const source = new SourceManager(video);

const glCanvas = $('glCanvas');
const cpuCanvas = $('cpuCanvas');
const tripleWrap = document.querySelector('.triple-wrap');
let activeCanvas = glCanvas;
const compare = new CompareView($('compareCanvas'), activeCanvas, () => layout?.panes);

// ---------- 引擎 ----------
function createEngine(kind) {
  if (kind === 'webgl') {
    if (!isWebGLAvailable()) throw new Error('当前浏览器不支持 WebGL');
    return new GLEngine(glCanvas);
  }
  return new CPUEngine(cpuCanvas);
}

function setActiveCanvas(kind) {
  activeCanvas = kind === 'webgl' ? glCanvas : cpuCanvas;
  glCanvas.classList.toggle('hidden', kind !== 'webgl');
  cpuCanvas.classList.toggle('hidden', kind !== 'cpu');
  compare.src = activeCanvas;
}

function syncBgAssets(eng) {
  eng.clearBgImage?.();
  if (params.background.mode === 'image' && pendingBgImage) eng.setBgImage(pendingBgImage);
  if (bgVideoEl) eng.setBgVideoElement(bgVideoEl);
}

try {
  engine = createEngine('webgl');
} catch (e) {
  console.warn(e);
  engineKind = 'cpu';
  engine = createEngine('cpu');
  setActiveCanvas('cpu');
  document.querySelector('input[name="engine"][value="cpu"]').checked = true;
  setStatus('WebGL 不可用，已切换 CPU 回退: ' + e.message, true);
}

// ---------- 性能统计 ----------
const perf = {
  frames: 0, lastT: performance.now(), fps: 0,
  cpuEwma: 0, dropped: 0, lastFrameTag: 0,
  lowStreak: 0,
};

function markPresented(now) {
  if (perf.lastFrameTag) {
    const gap = now - perf.lastFrameTag;
    if (gap > 1000 / 24) perf.dropped++; // 间隔 > 24fps 一帧周期记一次丢帧
  }
  perf.lastFrameTag = now;
}

// ---------- 主循环 ----------
let lastMetrics = null;
function frame(now) {
  source.tickFps(now);
  try {
    const rect = tripleWrap.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    layout = computeTripleLayout(rect.width || 320, rect.height || 180, dpr);
    if (engine.gl) { glCanvas.width = layout.W; glCanvas.height = layout.H; }
    const metrics = engine.render(video, params, layout);
    lastMetrics = metrics;
    markPresented(now);
    perf.frames++;
    perf.cpuEwma = perf.cpuEwma ? perf.cpuEwma * 0.9 + metrics.cpuMs * 0.1 : metrics.cpuMs;
    if (metrics.histogram && perf.frames % 6 === 0) {
      drawHistogram($('histogram'), metrics.histogram);
    }
    compare.draw($('zoomCanvas'));
    maybeAutoQuality();
  } catch (e) {
    console.error(e);
    setStatus('渲染错误: ' + e.message, true);
  }
  if (perf.frames % 20 === 0) updatePerfPanel();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function maybeAutoQuality() {
  if (!params.quality.autoQuality) return;
  const f = currentFps();
  if (f > 0 && f < 26) {
    perf.lowStreak++;
    if (perf.lowStreak > 60) {
      const sel = $('downscale');
      const order = ['1', '0.75', '0.5', '0.33'];
      const i = order.indexOf(String(params.quality.downscale));
      if (i < order.length - 1) {
        params.quality.downscale = parseFloat(order[i + 1]);
        sel.value = order[i + 1];
        setStatus(`动态质量：帧率 ${f.toFixed(0)} 偏低，降采样至 ${order[i + 1]}×`);
      }
      perf.lowStreak = 0;
    }
  } else {
    perf.lowStreak = 0;
  }
}

function currentFps() {
  const now = performance.now();
  const dt = now - perf.lastT;
  const f = perf.frames / (dt / 1000);
  perf.lastT = now; perf.frames = 0;
  perf.fps = perf.fps * 0.5 + f * 0.5;
  return perf.fps;
}

function updatePerfPanel() {
  const f = currentFps();
  $('pFps').textContent = f.toFixed(1) + ' fps';
  $('pCpu').textContent = perf.cpuEwma.toFixed(2) + ' ms';
  $('pGpu').textContent = lastMetrics?.gpuMs != null ? lastMetrics.gpuMs.toFixed(2) + ' ms'
    : (engineKind === 'cpu' ? 'n/a (CPU 模式)' : 'n/a');
  $('pDropped').textContent = perf.dropped;
  $('pPasses').textContent = lastMetrics?.passes ?? '—';
  if (lastMetrics) $('pResolution').textContent = `${lastMetrics.workW}×${lastMetrics.workH}`;
  // 顶部芯片
  $('chipFps').textContent = (source.measuredFps() || f).toFixed(0) + ' fps';
}

// ---------- 视频源 ----------
function setStatus(msg, isErr = false) {
  const el = $('statusLine');
  el.textContent = msg;
  el.style.color = isErr ? '#fca5a5' : '';
}

source.onStatus = (kind, info) => {
  const chips = [$('chipSource'), $('chipResolution'), $('chipColorSpace')];
  chips.forEach((c) => c.classList.remove('live', 'err'));
  if (kind === 'error') {
    $('chipSource').textContent = '⚠ ' + (info.message || '错误');
    $('chipSource').classList.add('err');
    setStatus(info.message || '错误', true);
    return;
  }
  $('chipSource').textContent = {
    camera: '📷 摄像头', file: '🎞 本地视频', demo: '🧪 测试绿幕', none: '无视频源',
  }[info.type] || info.type;
  if (info.type !== 'none') $('chipSource').classList.add('live');
  if (info.width) $('chipResolution').textContent = `${info.width}×${info.height}`;
  $('chipColorSpace').textContent = '色彩空间:' + (info.colorSpace || '—');
  const state = kind === 'playing' ? '播放中' : kind === 'pause' ? '已暂停'
    : kind === 'ended' ? '播放结束' : '已加载';
  setStatus(`${info.sourceName} · ${info.width || '?'}×${info.height || '?'} · ${state}`);
};

$('camToggle').addEventListener('change', async (e) => {
  if (e.target.checked) {
    const ok = await source.startCamera();
    if (!ok) e.target.checked = false;
  } else {
    source.detach();
    source.onStatus('pause', source.describe());
  }
});
$('btnUploadVideo').addEventListener('click', () => $('fileVideo').click());
$('fileVideo').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) { source.loadFile(f); $('camToggle').checked = false; }
});
$('btnSwitchSource').addEventListener('click', () => source.cycleSource());
$('btnPlay').addEventListener('click', () => source.play());
$('btnPause').addEventListener('click', () => source.pause());
$('btnStep').addEventListener('click', () => source.stepFrame());
$('chkLoop').addEventListener('change', (e) => source.setLoop(e.target.checked));

// ---------- 参数控件绑定 ----------
const BINDINGS = [
  ['threshold', 'key.threshold', 'range'],
  ['smoothness', 'key.smoothness', 'range'],
  ['shrink', 'key.shrink', 'range'],
  ['feather', 'key.feather', 'range'],
  ['erode', 'mask.erode', 'range'],
  ['dilate', 'mask.dilate', 'range'],
  ['blur', 'mask.blur', 'range'],
  ['denoise', 'mask.denoise', 'range'],
  ['spillStrength', 'spill.strength', 'range'],
  ['edgeColor', 'spill.edgeColor', 'range'],
  ['bgScale', 'background.scale', 'range'],
  ['bgOffsetX', 'background.offsetX', 'range'],
  ['bgOffsetY', 'background.offsetY', 'range'],
  ['brightness', 'grade.brightness', 'range'],
  ['contrast', 'grade.contrast', 'range'],
  ['saturation', 'grade.saturation', 'range'],
  ['temperature', 'grade.temperature', 'range'],
  ['tint', 'grade.tint', 'range'],
  ['curve', 'grade.curve', 'range'],
];

function getPath(obj, path) { return path.split('.').reduce((o, k) => o[k], obj); }
function setPath(obj, path, v) {
  const ks = path.split('.');
  const last = ks.pop();
  ks.reduce((o, k) => o[k], obj)[last] = v;
}

function fmt(id, v) {
  if (['shrink', 'feather', 'erode', 'dilate', 'blur'].includes(id)) return String(v);
  return (+v).toFixed(2);
}

const PATH_BY_ID = Object.fromEntries(BINDINGS.map(([id, path]) => [id, path]));

function refreshValueLabel(id) {
  const v = getPath(params, PATH_BY_ID[id]);
  $('v_' + id).textContent = fmt(id, v);
}

for (const [id, path, type] of BINDINGS) {
  const el = $(id);
  el.value = getPath(params, path);
  refreshValueLabel(id);
  el.addEventListener('input', () => {
    setPath(params, path, type === 'range' ? parseFloat(el.value) : el.value);
    refreshValueLabel(id);
  });
}

// 复选框 / 下拉 / 颜色
function bindCheck(id, path) {
  const el = $(id);
  el.checked = getPath(params, path);
  el.addEventListener('change', () => setPath(params, path, el.checked));
}
bindCheck('outputAlpha', 'key.outputAlpha');
bindCheck('preserveSemi', 'mask.preserveSemi');
bindCheck('spillLink', 'spill.linkGrade');
bindCheck('bgLoop', 'background.loop');
bindCheck('colorMatch', 'background.colorMatch');
bindCheck('lightMatch', 'grade.lightMatch');
bindCheck('autoQuality', 'quality.autoQuality');
$('chkLoop').checked = true;

$('keyMode').addEventListener('change', (e) => { params.key.mode = e.target.value; });
$('spillChannel').addEventListener('change', (e) => { params.spill.channel = e.target.value; });
$('downscale').addEventListener('change', (e) => {
  params.quality.downscale = parseFloat(e.target.value);
});

function rgbToHex(rgb) {
  return '#' + rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
$('keyColor').value = rgbToHex(params.key.color);
$('keyColor').addEventListener('input', (e) => {
  params.key.color = hexToRgb(e.target.value);
});
$('bgColor').value = rgbToHex(params.background.color);
$('bgColor').addEventListener('input', (e) => {
  params.background.color = hexToRgb(e.target.value);
});

// 幕色快捷
document.querySelectorAll('[data-screen]').forEach((b) => {
  b.addEventListener('click', () => {
    const map = { green: [0, 0.694, 0.251], blue: [0.08, 0.25, 0.95] };
    params.key.color = map[b.dataset.screen];
    $('keyColor').value = rgbToHex(params.key.color);
    params.spill.channel = b.dataset.screen;
    $('spillChannel').value = b.dataset.screen;
  });
});

// ---------- 吸管 ----------
$('btnEyedropper').addEventListener('click', () => {
  eyedropperOn = !eyedropperOn;
  $('eyedropperHint').classList.toggle('hidden', !eyedropperOn);
});
$('eyedropperHint').addEventListener('click', () => {
  eyedropperOn = false;
  $('eyedropperHint').classList.add('hidden');
});
function handleEyedrop(e) {
  if (!eyedropperOn) return;
  const r = activeCanvas.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  const paneIdx = px < 1 / 3 ? 0 : px < 2 / 3 ? 1 : 2;
  const nx = (px - paneIdx / 3) * 3;
  const workAspect = lastMetrics ? lastMetrics.workW / lastMetrics.workH : 16 / 9;
  const paneW = r.width / 3;
  const paneAspect = paneW / r.height;
  const rgb = engine.pickOriginal(nx, py, workAspect, paneAspect);
  params.key.color = rgb;
  $('keyColor').value = rgbToHex(rgb);
  eyedropperOn = false;
  $('eyedropperHint').classList.add('hidden');
  setStatus(`吸管取色: rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})（取自 ${['原始', '遮罩', '合成'][paneIdx]} 窗）`);
}
glCanvas.addEventListener('click', handleEyedrop);
cpuCanvas.addEventListener('click', handleEyedrop);

// ---------- 背景素材 ----------
let pendingBgImage = null;
document.querySelectorAll('[data-bg]').forEach((b) => {
  b.addEventListener('click', () => {
    const mode = b.dataset.bg;
    params.background.mode = mode;
    if (mode === 'image') $('fileBgImage').click();
    if (mode === 'video') $('fileBgVideo').click();
    if (mode === 'solid' || mode === 'blur') syncBgAssets(engine);
  });
});
$('fileBgImage').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    pendingBgImage = img;
    params.background.mode = 'image';
    engine.setBgImage(img);
    setStatus('背景图片已加载: ' + f.name);
  };
  img.src = url;
});
$('fileBgVideo').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  bgVideoEl = document.createElement('video');
  bgVideoEl.src = url; bgVideoEl.muted = true; bgVideoEl.loop = params.background.loop;
  bgVideoEl.playsInline = true;
  bgVideoEl.play().catch(() => {});
  params.background.mode = 'video';
  engine.setBgVideoElement(bgVideoEl);
  setStatus('背景视频已加载: ' + f.name);
});
$('bgLoop').addEventListener('change', () => {
  if (bgVideoEl) bgVideoEl.loop = params.background.loop;
});

// ---------- 引擎切换 ----------
document.querySelectorAll('input[name="engine"]').forEach((r) => {
  r.addEventListener('change', (e) => {
    const kind = e.target.value;
    try {
      engine = createEngine(kind);
      engineKind = kind;
      setActiveCanvas(kind);
      syncBgAssets(engine);
      perf.dropped = 0;
      setStatus(kind === 'webgl' ? '已切换 WebGL 多 Pass 渲染' : '已切换 CPU Canvas 回退渲染');
    } catch (err) {
      setStatus('切换失败: ' + err.message, true);
      e.target.checked = false;
      document.querySelector(`input[name="engine"][value="${engineKind}"]`).checked = true;
    }
  });
});

// ---------- 预览对比控件 ----------
$('btnSplit').addEventListener('click', () => {
  compare.toggleOrientation();
});
const ba = $('btnBeforeAfter');
ba.addEventListener('pointerdown', () => { compare.showBefore = true; ba.textContent = '松开看合成'; });
window.addEventListener('pointerup', () => {
  compare.showBefore = false; ba.textContent = '按住看原始效果';
});

// ---------- 预设 ----------
async function refreshPresetList() {
  const items = await loadAllPresets();
  const sel = $('savedPresets');
  sel.innerHTML = '<option value="">已保存预设…</option>' +
    items.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('');
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function applyParams(incoming) {
  const merged = mergeParams(params, incoming);
  Object.assign(params, merged);
  syncUIFromParams();
  syncBgAssets(engine);
}
function syncUIFromParams() {
  for (const [id, path] of BINDINGS) {
    $(id).value = getPath(params, path);
    refreshValueLabel(id);
  }
  $('keyMode').value = params.key.mode;
  $('spillChannel').value = params.spill.channel;
  $('downscale').value = String(params.quality.downscale);
  $('keyColor').value = rgbToHex(params.key.color);
  $('bgColor').value = rgbToHex(params.background.color);
  $('outputAlpha').checked = params.key.outputAlpha;
  $('preserveSemi').checked = params.mask.preserveSemi;
  $('spillLink').checked = params.spill.linkGrade;
  $('bgLoop').checked = params.background.loop;
  $('colorMatch').checked = params.background.colorMatch;
  $('lightMatch').checked = params.grade.lightMatch;
  $('autoQuality').checked = params.quality.autoQuality;
}
document.querySelectorAll('[data-preset]').forEach((b) => {
  b.addEventListener('click', () => {
    const pre = BUILTIN_PRESETS[b.dataset.preset];
    applyParams(pre.params);
    setStatus(`已应用内置预设：${pre.name}`);
  });
});
$('btnSavePreset').addEventListener('click', async () => {
  const name = prompt('预设名称：', '我的预设 ' + new Date().toLocaleString());
  if (!name) return;
  await savePreset(name.trim(), params);
  await refreshPresetList();
  $('savedPresets').value = name.trim();
  setStatus('预设已保存到 IndexedDB: ' + name.trim());
});
$('btnLoadPreset').addEventListener('click', async () => {
  const name = $('savedPresets').value;
  if (!name) return;
  const items = await loadAllPresets();
  const p = items.find((x) => x.name === name);
  if (p) { applyParams(p.params); setStatus('已加载预设: ' + name); }
});
$('btnDelPreset').addEventListener('click', async () => {
  const name = $('savedPresets').value;
  if (!name) return;
  await deletePreset(name);
  await refreshPresetList();
  setStatus('已删除预设: ' + name);
});
refreshPresetList();

// ---------- 参数 JSON 导入导出 ----------
function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('btnExportParams').addEventListener('click', () => {
  downloadText('greenroom-params.json', paramsToJSON(params));
  setStatus('参数 JSON 已导出');
});
$('btnImportParams').addEventListener('click', () => $('fileParams').click());
$('fileParams').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = data.params || data;
    applyParams(incoming);
    setStatus('参数 JSON 已导入: ' + f.name);
  } catch (err) {
    setStatus('参数 JSON 解析失败: ' + err.message, true);
  }
});

// ---------- 媒体导出 ----------
function slicePaneToCanvas(paneIdx, w = 960, h = 540) {
  const panes = layout.panes;
  const pane = panes[paneIdx];
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  // cover 源裁区
  const pa = pane.w / pane.h, ta = w / h;
  let sx, sy, sw, sh;
  if (pa > ta) { sw = pane.h * ta; sh = pane.h; sx = pane.x + (pane.w - sw) / 2; sy = pane.y; }
  else { sh = pane.w / ta; sw = pane.w; sx = pane.x; sy = pane.y + (pane.h - sh) / 2; }
  ctx.drawImage(activeCanvas, sx, sy, sw, sh, 0, 0, w, h);
  return out;
}
$('btnExportMask').addEventListener('click', () => {
  slicePaneToCanvas(1).toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'greenroom-mask.png'; a.click();
    setStatus('遮罩预览 PNG 已导出');
  });
});
$('btnExportComposite').addEventListener('click', () => {
  slicePaneToCanvas(2).toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'greenroom-composite.png'; a.click();
    setStatus('合成画面 PNG 已导出');
  });
});
$('btnExportReport').addEventListener('click', () => {
  const d = source.describe();
  const report = [
    'GreenRoom 对比信息报告',
    '======================',
    `时间: ${new Date().toLocaleString()}`,
    `引擎: ${engineKind === 'webgl' ? 'WebGL 多 Pass' : 'CPU Canvas 回退'}`,
    `视频源: ${d.sourceName}`,
    `原始分辨率: ${d.width}×${d.height}`,
    `渲染分辨率: ${lastMetrics?.workW}×${lastMetrics?.workH}`,
    `降采样: ${params.quality.downscale}×`,
    `源帧率(估): ${(d.fps || 0).toFixed(1)} fps`,
    `渲染帧率: ${perf.fps.toFixed(1)} fps`,
    `CPU 耗时: ${perf.cpuEwma.toFixed(2)} ms`,
    `GPU 耗时: ${lastMetrics?.gpuMs != null ? lastMetrics.gpuMs.toFixed(2) + ' ms' : 'n/a'}`,
    `Pass 数: ${lastMetrics?.passes ?? '—'}`,
    `丢帧: ${perf.dropped}`,
    `色彩空间: ${d.colorSpace}`,
    '----------------------',
    `键色空间: ${params.key.mode}  阈值: ${params.key.threshold}  平滑: ${params.key.smoothness}`,
    `收缩: ${params.key.shrink}px  羽化: ${params.key.feather}px`,
    `腐蚀/膨胀/模糊: ${params.mask.erode}/${params.mask.dilate}/${params.mask.blur}`,
    `溢色: ${params.spill.channel} 强度 ${params.spill.strength}`,
    `背景: ${params.background.mode}`,
    '======================',
    '完整参数 JSON:',
    paramsToJSON(params),
  ].join('\n');
  downloadText('greenroom-report.txt', report, 'text/plain');
});

// ---------- 启动：自动进入内置测试绿幕，保证打开即可看到三路效果 ----------
window.addEventListener('click', function onceHint() {
  // 某些浏览器自动播放受限；若测试源未播放，用户首次点击时恢复（仅一次）
  if (video.paused && source.type === 'demo') source.play();
  window.removeEventListener('click', onceHint);
});
source.startDemo();
setStatus('已启动内置测试绿幕源（可直接调参）；也可开摄像头或上传视频。');
