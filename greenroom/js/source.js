// 视频输入管理：摄像头 / 本地文件 / 内置合成测试源
export class SourceManager {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.currentObjectUrl = null;
    this.type = 'none'; // camera | file | demo | none
    this.list = [];      // 已加载的源（文件 url 等）
    this.listIndex = -1;
    this.onStatus = () => {};
    this.fpsSamples = [];
    this._lastFrameTime = 0;

    videoEl.addEventListener('loadedmetadata', () => {
      this.onStatus('loaded', this.describe());
    });
    videoEl.addEventListener('playing', () => this.onStatus('playing', this.describe()));
    videoEl.addEventListener('pause', () => this.onStatus('pause', this.describe()));
    videoEl.addEventListener('ended', () => {
      if (!videoEl.loop) this.onStatus('ended', this.describe());
    });
    videoEl.addEventListener('error', () => this.onStatus('error', { message: '视频解码错误' }));
  }

  // 内置测试源：canvas 绘制移动色块 + 噪声的绿幕动画
  startDemo() {
    this.detach();
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const ctx = c.getContext('2d');
    let t = 0;
    const draw = () => {
      t += 0.04;
      // 绿色渐变背景（模拟标准绿幕 #00b140 的不均匀光照）
      const grad = ctx.createLinearGradient(0, 0, 640, 360);
      grad.addColorStop(0, '#007d2e');
      grad.addColorStop(0.5, '#00c34a');
      grad.addColorStop(1, '#006e28');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 640, 360);
      // “前景人物”：移动的圆形+矩形组合
      const cx = 320 + Math.sin(t) * 150, cy = 190 + Math.cos(t * 0.7) * 30;
      ctx.fillStyle = '#d8b08a';
      ctx.beginPath(); ctx.arc(cx, cy, 42, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c23535';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 110, 80, 95, 0, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#e8e2d4';
      ctx.fillRect(cx - 80, cy + 60, 30, 120);
      ctx.fillRect(cx + 50, cy + 60, 30, 120);
      // 噪点（让降噪参数可见）
      const img = ctx.getImageData(0, 0, 640, 360);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 24;
        img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
      }
      ctx.putImageData(img, 0, 0);
      raf = requestAnimationFrame(draw);
    };
    let raf = requestAnimationFrame(draw);
    this.demoRAF = raf;
    const stream = c.captureStream(30);
    this.stream = stream;
    this.video.srcObject = stream;
    this.type = 'demo';
    this.video.play().catch(() => {});
    this.onStatus('playing', this.describe());
  }

  async startCamera(deviceId) {
    this.detach();
    try {
      this.onStatus('loading', { message: '正在请求摄像头…' });
      const constraints = {
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.stream = stream;
      this.video.srcObject = stream;
      this.type = 'camera';
      await this.video.play();
      const track = stream.getVideoTracks()[0];
      this._trackSettings = track ? track.getSettings() : null;
      this.onStatus('playing', this.describe());
      return true;
    } catch (e) {
      this.onStatus('error', { message: '摄像头不可用: ' + e.message });
      return false;
    }
  }

  loadFile(file) {
    this.detach();
    const url = URL.createObjectURL(file);
    this.currentObjectUrl = url;
    this.video.src = url;
    this.type = 'file';
    this.video.play().catch(() => {});
    if (!this.list.some((s) => s.url === url)) {
      this.list.push({ name: file.name, url });
      this.listIndex = this.list.length - 1;
    }
    this.onStatus('loaded', this.describe());
  }

  // 在已加载源之间切换（摄像头/测试源/文件循环）
  async cycleSource() {
    if (this.type === 'file' && this.list.length > 1) {
      this.listIndex = (this.listIndex + 1) % this.list.length;
      const item = this.list[this.listIndex];
      this.detach({ keepList: true });
      this.currentObjectUrl = item.url;
      this.video.src = item.url;
      this.type = 'file';
      this.video.play().catch(() => {});
      return;
    }
    if (this.type === 'camera') this.startDemo();
    else await this.startCamera();
  }

  detach(opts = {}) {
    if (this.demoRAF) { cancelAnimationFrame(this.demoRAF); this.demoRAF = null; }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.currentObjectUrl && !opts.keepList) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.srcObject = null;
    this.video.load();
    if (!opts.keepList) { this.type = 'none'; }
  }

  play() { if (this.video.src || this.video.srcObject) this.video.play(); }
  pause() { this.video.pause(); }

  async stepFrame() {
    this.video.pause();
    if (this.video.requestVideoFrameCallback) {
      await new Promise((res) => this.video.requestVideoFrameCallback(res));
    }
    this.video.currentTime = Math.min(
      this.video.duration || 1e9,
      this.video.currentTime + 1 / (this.measuredFps() || 30)
    );
  }

  setLoop(v) { this.video.loop = v; }

  // 基于 rAF 间隔估算实际帧率（由外部每帧调用 tickFps）
  tickFps(now) {
    if (this._lastFrameTime) {
      const dt = now - this._lastFrameTime;
      if (dt > 0 && dt < 500) {
        this.fpsSamples.push(1000 / dt);
        if (this.fpsSamples.length > 60) this.fpsSamples.shift();
      }
    }
    this._lastFrameTime = now;
  }

  measuredFps() {
    if (!this.fpsSamples.length) return 0;
    return this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
  }

  colorSpace() {
    const s = this._trackSettings || {};
    // 浏览器当前不直接暴露像素色彩空间；摄像头/BT.709 视频通常为 BT.709
    if (s.deviceId) return 'BT.709 (camera)';
    if (this.type === 'file') return 'BT.709 (tag:unknown)';
    if (this.type === 'demo') return 'sRGB (合成源)';
    return '—';
  }

  describe() {
    return {
      type: this.type,
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      fps: this.measuredFps(),
      colorSpace: this.colorSpace(),
      paused: this.video.paused,
      loop: this.video.loop,
      sourceName: this.type === 'camera' ? '摄像头'
        : this.type === 'demo' ? '内置测试绿幕'
        : this.type === 'file' ? (this.list[this.listIndex]?.name || '本地视频')
        : '无',
    };
  }
}
