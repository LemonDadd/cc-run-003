// WebGL 多 Pass 渲染引擎
// 管线：场景采集 → (背景模糊) → 色度键/溢色/调色 → 形态学 → 高斯 → 遮罩精修
//       → 背景合成 → 三路视口输出；另含统计/直方图小 Pass
import { VERT, SCENE_FRAG, KEY_FRAG, MORPH_FRAG, GAUSS_FRAG,
  POST_MASK_FRAG, COMPOSITE_FRAG, MASK_VIEW_FRAG } from './shaders.js';
import { paneToUv } from '../layout.js';
import { FEATHER_SCALE, lightMatchFromStats, applyLightMatch } from '../keying.js';

const DISPLAY_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform int uMask;        // 1 = 遮罩棋盘预览
uniform vec2 uCrop;       // cover 裁切可见比例
void main() {
  vec2 uv = (vUv - 0.5) * uCrop + 0.5;
  vec4 c = texture2D(uTex, uv);
  if (uMask == 1) {
    vec2 cb = step(0.5, fract(uv * vec2(40.0, 22.0)));
    float chk = mod(cb.x + cb.y, 2.0);
    vec3 base = mix(vec3(0.12), vec3(0.22), chk);
    gl_FragColor = vec4(mix(base, vec3(1.0), c.a), 1.0);
  } else {
    gl_FragColor = c;
  }
}`;

const STAT_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uFg;
uniform sampler2D uBg;
uniform int uMode; // 0=前景(预乘rgb+覆盖度) 1=背景rgb
void main() {
  if (uMode == 0) {
    vec4 fg = texture2D(uFg, vUv);
    gl_FragColor = vec4(fg.rgb * fg.a, fg.a);
  } else {
    gl_FragColor = texture2D(uBg, vUv);
  }
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader 编译失败: ' + log);
  }
  return s;
}

class Program {
  constructor(gl, fragSrc) {
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program 链接失败: ' + gl.getProgramInfoLog(p));
    }
    this.p = p;
    this.loc = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      this.loc[info.name.replace('[0]', '')] = gl.getUniformLocation(p, info.name);
    }
  }
  use() { this.gl.useProgram(this.p); }
  set1(name, v) { const l = this.loc[name]; if (l) this.gl.uniform1f(l, v); }
  set1i(name, v) { const l = this.loc[name]; if (l) this.gl.uniform1i(l, v); }
  set2(name, x, y) { const l = this.loc[name]; if (l) this.gl.uniform2f(l, x, y); }
  set3(name, x, y, z) { const l = this.loc[name]; if (l) this.gl.uniform3f(l, x, y, z); }
  set3v(name, arr) { const l = this.loc[name]; if (l) this.gl.uniform3fv(l, arr); }
}

export class GLEngine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
            || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL 不可用');
    this.gl = gl;
    this.isWebGL2 = !!(gl instanceof WebGL2RenderingContext);

    // 全屏三角形
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.progScene = new Program(gl, SCENE_FRAG);
    this.progKey = new Program(gl, KEY_FRAG);
    this.progMorph = new Program(gl, MORPH_FRAG);
    this.progGauss = new Program(gl, GAUSS_FRAG);
    this.progPost = new Program(gl, POST_MASK_FRAG);
    this.progComp = new Program(gl, COMPOSITE_FRAG);
    this.progDisplay = new Program(gl, DISPLAY_FRAG);
    this.progStat = new Program(gl, STAT_FRAG);

    this.texVideo = this._createTex();
    this.texBgImage = this._createTex();
    this.texBgVideo = this._createTex();
    this.hasBgImage = false;
    this.hasBgVideo = false;

    this.workW = 0; this.workH = 0;
    this.matchExp = 1; this.matchTint = [1, 1, 1];
    this.frameNo = 0;
    this.histogram = new Array(256).fill(0);
    this._histAcc = null; this._histFrames = 0;

    // GPU 计时查询环
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.qRing = []; this.qi = 0; this.gpuMs = null;
    if (this.timerExt) {
      for (let i = 0; i < 4; i++) this.qRing.push(gl.createQuery());
    }
  }

  _createTex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _target(w, h) {
    const gl = this.gl;
    const tex = this._createTex();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }

  _bindLayout() {
    const gl = this.gl;
    const p = gl.getParameter(gl.CURRENT_PROGRAM);
    const loc = gl.getAttribLocation(p, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  setBgImage(img) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texBgImage);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.hasBgImage = true;
  }

  clearBgImage() { this.hasBgImage = false; }

  _uploadVideoTex(tex, video) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  _ensureSize(w, h) {
    if (w === this.workW && h === this.workH) return;
    this.workW = w; this.workH = h;
    this.scene = this._target(w, h);
    this.keyA = this._target(w, h);
    this.keyB = this._target(w, h);
    this.bgA = this._target(w, h);
    this.bgB = this._target(w, h);
    this.stat = this._target(16, 16);
    this.histT = this._target(128, 72);
  }

  _draw(tex, target, prog, uniforms, flip = 0) {
    const gl = this.gl;
    if (target) gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (target) gl.viewport(0, 0, target.w, target.h);
    prog.use();
    this._bindLayout();
    prog.set1('uFlipY', flip);
    uniforms(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    prog.set1i('uTex', 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passCount++;
  }

  // 主渲染：video 为 HTMLVideoElement；layout 为 computeTripleLayout 结果
  render(video, params, layout) {
    const gl = this.gl;
    const t0 = performance.now();
    this.passCount = 0;
    this.frameNo++;

    // GPU 计时：回收 4 帧前的查询结果，并开始包裹本帧全部 GL 工作
    if (this.timerExt) { this._pollTimer(); this._beginTimer(); }

    const vw = video && video.videoWidth ? video.videoWidth : 1280;
    const vh = video && video.videoHeight ? video.videoHeight : 720;
    const ds = params.quality.downscale;
    let w = Math.max(64, Math.round(vw * ds));
    let h = Math.max(64, Math.round(vh * ds));
    this._ensureSize(w, h);

    // 1) 场景采集 Pass
    let srcTex = this.texVideo;
    if (video && video.videoWidth) {
      this._uploadVideoTex(this.texVideo, video);
    } else {
      this._ensureBlackTex();
      srcTex = this._blackTexData;
    }
    this._draw(srcTex, this.scene, this.progScene, () => {});

    // 2) 背景：模糊场景（多次可分离近似：连续 3x3 高斯）
    let bgTex = null;
    if (params.background.mode === 'blur') {
      bgTex = this._gaussChain(this.scene, this.bgA, this.bgB, 4, 0).tex;
    }

    // 3) 色度键 + 溢色 + 调色
    this._keyPass(this.keyA, params);

    // 4) 形态学（腐蚀 / 膨胀 / 边缘收缩）
    let cur = this.keyA;
    const morphTo = (mode) => {
      const dst = cur === this.keyA ? this.keyB : this.keyA;
      this._morph(cur, dst, mode);
      cur = dst;
    };
    for (let i = 0; i < params.mask.erode; i++) morphTo(0);
    for (let i = 0; i < params.mask.dilate; i++) morphTo(1);
    for (let i = 0; i < params.key.shrink; i++) morphTo(0);

    // 5) alpha 高斯模糊（仅模糊 alpha，pingpong 在 keyA/keyB 间）
    if (params.mask.blur > 0) {
      for (let i = 0; i < params.mask.blur; i++) {
        const dst = cur === this.keyA ? this.keyB : this.keyA;
        this._gaussOnce(cur, dst, 1);
        cur = dst;
      }
    }

    // 6) 遮罩精修（羽化 / 降噪 / 半透明保留）
    const fgTarget = cur === this.keyA ? this.keyB : this.keyA;
    this._postMask(cur, fgTarget, params);
    cur = fgTarget;

    // 7) 周期性统计：前背景亮度/色彩匹配
    if (this.frameNo % 30 === 0) this._updateStats(cur, bgTex);

    // 8) 合成
    const compTarget = cur === this.keyA ? this.keyB : this.keyA;
    this._composite(cur, bgTex, compTarget, params);

    // 9) 直方图小目标（每 12 帧更新）
    if (this.frameNo % 12 === 0) this._updateHistogram(cur);

    // 10) 三路视口输出到画布
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, layout.W, layout.H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const paneAspect = layout.panes[0].w / layout.panes[0].h;
    const crop = this._coverCrop(w / h, paneAspect);
    for (let i = 0; i < 3; i++) {
      const pn = layout.panes[i];
      gl.viewport(pn.x, pn.y, pn.w, pn.h);
      if (i === 0) this._blitDisplay(this.scene.tex, 0, crop);
      else if (i === 1) this._blitDisplay(cur.tex, 1, crop);
      else this._blitDisplay(compTarget.tex, 0, crop);
    }

    if (this.timerExt) this._endTimer();

    return {
      cpuMs: performance.now() - t0,
      gpuMs: this.gpuMs,
      passes: this.passCount,
      workW: w, workH: h,
      histogram: this.histogram,
    };
  }

  _ensureBlackTex() {
    if (this._blackTexData) return;
    const gl = this.gl;
    this._blackTexData = this._createTex();
    gl.bindTexture(gl.TEXTURE_2D, this._blackTexData);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([6, 8, 12, 255, 6, 8, 12, 255, 6, 8, 12, 255, 6, 8, 12, 255]));
  }

  _coverCrop(srcAspect, paneAspect) {
    if (srcAspect > paneAspect) return [paneAspect / srcAspect, 1];
    return [1, srcAspect / paneAspect];
  }

  _blitDisplay(tex, maskMode, crop) {
    const gl = this.gl;
    const prog = this.progDisplay;
    prog.use();
    this._bindLayout();
    prog.set1('uFlipY', 0);
    prog.set1i('uMask', maskMode);
    prog.set2('uCrop', crop[0], crop[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    prog.set1i('uTex', 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passCount++;
  }

  _keyPass(target, params) {
    const gl = this.gl;
    const p = this.progKey;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    p.use(); this._bindLayout();
    p.set1('uFlipY', 0);
    const k = params.key;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    p.set1i('uScene', 0);
    p.set3v('uKeyColor', k.color);
    p.set1i('uMode', k.mode === 'YUV' ? 1 : k.mode === 'HSV' ? 2 : 0);
    p.set1('uThreshold', k.threshold);
    p.set1('uSmooth', k.smoothness);
    const s = params.spill;
    p.set1i('uSpill', s.channel === 'green' ? 1 : s.channel === 'blue' ? 2 : 0);
    p.set1('uSpillStrength', s.strength);
    p.set1('uEdgeColor', s.edgeColor);
    const g = params.grade;
    p.set1('uBrightness', g.brightness);
    p.set1('uContrast', g.contrast);
    p.set1('uSaturation', g.saturation);
    p.set1('uTemperature', g.temperature);
    p.set1('uTint', g.tint);
    p.set1('uGamma', g.curve);
    // 光照统一 → 曝光；色彩匹配 → 通道色调；溢色联动时匹配结果减半应用避免过冲
    const link = s.linkGrade ? 0.85 : 1.0;
    p.set1('uMatchExp', g.lightMatch ? (1 + (this.matchExp - 1) * link) : 1);
    const t = params.background.colorMatch ? this.matchTint : [1, 1, 1];
    p.set3('uMatchTint',
      1 + (t[0] - 1) * link, 1 + (t[1] - 1) * link, 1 + (t[2] - 1) * link);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passCount++;
  }

  _morph(src, dst, mode) {
    const gl = this.gl;
    const p = this.progMorph;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    p.use(); this._bindLayout();
    p.set1('uFlipY', 0);
    p.set1i('uMode', mode);
    p.set2('uPx', 1 / src.w, 1 / src.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    p.set1i('uTex', 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passCount++;
  }

  // 单次 3x3 高斯；alphaOnly=1 时仅模糊 alpha
  _gaussOnce(src, dst, alphaOnly) {
    const gl = this.gl;
    const p = this.progGauss;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    p.use(); this._bindLayout();
    p.set1('uFlipY', 0);
    p.set2('uPx', 1 / src.w, 1 / src.h);
    p.set1i('uAlphaOnly', alphaOnly);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    p.set1i('uTex', 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passCount++;
  }

  // 背景强模糊：在 bgA/bgB 间 pingpong，返回最终目标
  _gaussChain(srcTarget, tmpA, tmpB, iters, alphaOnly) {
    let src = srcTarget;
    for (let i = 0; i < iters; i++) {
      const dst = (i % 2 === 0) ? tmpA : tmpB;
      this._gaussOnce(src, dst, alphaOnly);
      src = dst;
    }
    return src;
  }

  _postMask(src, dst, params) {
    const gl = this.gl;
    const p = this.progPost;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    p.use(); this._bindLayout();
    p.set1('uFlipY', 0);
    p.set2('uPx', 1 / src.w, 1 / src.h);
    p.set1('uFeatherW', params.key.feather * FEATHER_SCALE);
    p.set1('uDenoise', params.mask.denoise);
    p.set1i('uPreserveSemi', params.mask.preserveSemi ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    p.set1i('uTex', 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passCount++;
  }

  _bgSource(params) {
    const m = params.background.mode;
    if (m === 'image' && this.hasBgImage) return this.texBgImage;
    if (m === 'video' && this.hasBgVideo) return this.texBgVideo;
    return null;
  }

  _composite(fg, blurTex, dst, params) {
    const gl = this.gl;
    // 背景视频纹理逐帧上传
    if (params.background.mode === 'video' && this.bgVideoElement && this.bgVideoElement.readyState >= 2) {
      this._uploadVideoTex(this.texBgVideo, this.bgVideoElement);
      this.hasBgVideo = true;
    }
    const p = this.progComp;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    p.use(); this._bindLayout();
    p.set1('uFlipY', 0);
    const b = params.background;
    const mode = b.mode === 'solid' ? 0 : b.mode === 'image' ? 1 : b.mode === 'video' ? 2 : 3;
    p.set1i('uBgMode', mode);
    p.set3v('uBgColor', b.color);
    p.set1('uBgScale', b.scale);
    p.set2('uBgOffset', b.offsetX, b.offsetY);
    p.set1i('uShowAlpha', params.key.outputAlpha ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fg.tex);
    p.set1i('uFg', 0);
    gl.activeTexture(gl.TEXTURE1);
    const src = b.mode === 'blur' ? blurTex : this._bgSource(params);
    gl.bindTexture(gl.TEXTURE_2D, src || this.scene.tex);
    p.set1i('uBg', 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passCount++;
  }

  _updateStats(fg, bgTex) {
    const gl = this.gl;
    const p = this.progStat;
    const STAT_N = 16 * 16;
    const read = (mode) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.stat.fbo);
      gl.viewport(0, 0, 16, 16);
      p.use(); this._bindLayout();
      p.set1('uFlipY', 0);
      p.set1i('uMode', mode);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fg.tex);
      p.set1i('uFg', 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bgTex || this.scene.tex);
      p.set1i('uBg', 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.passCount++;
      const buf = new Uint8Array(STAT_N * 4);
      gl.readPixels(0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    // STAT_FRAG mode0 输出 rgb*a（预乘，字节 0..255）与覆盖度 a（字节/255）。
    // 均值/曝光/tint 一律按 0..255 口径，由 keying.js 单一公式计算（CPU 同一份）。
    let fgRS = 0, fgGS = 0, fgBS = 0, fgAS = 0;
    const fgBuf = read(0);
    for (let i = 0; i < fgBuf.length; i += 4) {
      fgRS += fgBuf[i]; fgGS += fgBuf[i + 1]; fgBS += fgBuf[i + 2];
      fgAS += fgBuf[i + 3] / 255;
    }
    let bgRS = 0, bgGS = 0, bgBS = 0;
    const bgBuf = read(1);
    for (let i = 0; i < bgBuf.length; i += 4) {
      bgRS += bgBuf[i]; bgGS += bgBuf[i + 1]; bgBS += bgBuf[i + 2];
    }
    const target = lightMatchFromStats({
      fgRS, fgGS, fgBS, fgAS, bgRS, bgGS, bgBS, n: STAT_N,
    });
    if (target) applyLightMatch(this, target);
  }

  _updateHistogram(fg) {
    const gl = this.gl;
    // 将遮罩缩小到 128x72
    this._draw(fg.tex, this.histT, this.progScene, () => {});
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histT.fbo);
    const buf = new Uint8Array(128 * 72 * 4);
    gl.readPixels(0, 0, 128, 72, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const bins = new Array(256).fill(0);
    for (let i = 3; i < buf.length; i += 4) bins[buf[i]]++;
    this.histogram = bins;
  }

  // 吸管：pane 内归一化坐标 → 原始场景颜色
  pickOriginal(nx, ny, workAspect, paneAspect) {
    const [u, v] = paneToUv(nx, ny, workAspect, paneAspect);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    const px = Math.max(0, Math.min(this.workW - 1, Math.round(u * this.workW)));
    const py = Math.max(0, Math.min(this.workH - 1, Math.round((1 - v) * this.workH)));
    const buf = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return [buf[0] / 255, buf[1] / 255, buf[2] / 255];
  }

  _pollTimer() {
    const gl = this.gl, ext = this.timerExt;
    const q = this.qRing[this.qi];
    const avail = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE_EXT);
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (avail && !disjoint) {
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT_EXT);
      if (ns > 0) this.gpuMs = ns / 1e6;
    }
  }

  _beginTimer() {
    const gl = this.gl, ext = this.timerExt;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, this.qRing[this.qi]);
  }

  _endTimer() {
    const gl = this.gl, ext = this.timerExt;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.qi = (this.qi + 1) % this.qRing.length;
  }

  setBgVideoElement(v) { this.bgVideoElement = v; this.hasBgVideo = false; }
}

export function isWebGLAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}
