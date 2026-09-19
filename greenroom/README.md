# GreenRoom · 浏览器实时视频绿幕抠像与虚拟背景合成器

纯前端（原生 ES Modules + WebGL，零构建、零依赖）实时色度键合成器。打开页面即用内置测试绿幕源演示，无需摄像头、无需上传素材。

## 运行

必须通过 HTTP 提供（ES Module 与 `captureStream` 等在 `file://` 下受限）：

```bash
cd greenroom
python3 -m http.server 8000
# 打开 http://127.0.0.1:8000
```

任何静态服务器均可（`npx serve`、VSCode Live Server 等）。

## 功能总览

| 模块 | 能力 |
|---|---|
| 视频输入 | 摄像头采集、本地视频上传、播放/暂停/逐帧/循环、内置测试绿幕源、源切换、原始分辨率/帧率/色彩空间/状态提示 |
| 色度键 | 吸管取色、绿幕/蓝幕/自定义键色、RGB / YUV / HSV 三种色度空间、相似度阈值、平滑度、边缘收缩、边缘羽化、输出 alpha |
| 遮罩后处理 | 形态学腐蚀、膨胀、3×3 高斯（仅 alpha）、噪点抑制、半透明区域保留、遮罩棋盘预览、256 bin alpha 直方图 |
| 溢色抑制 | 绿/蓝溢色抑制、强度、边缘颜色校正、与前景调色联动 |
| 背景合成 | 纯色 / 图片 / 视频 / 原视频多级模糊、缩放、位移、视频循环、前背景基础色彩匹配 |
| 前景调色 | 亮度、对比度、饱和度、色温、色调、gamma 曲线、前背景光照统一 |
| 预览对比 | 原始 / 遮罩 / 合成 三路同屏、可拖动分屏、横竖切换、按住看原始、3× 放大镜看边缘 |
| 性能面板 | WebGL/CPU 切换、渲染分辨率、帧率、CPU 耗时、GPU 耗时（EXT_disjoint_timer_query_webgl2）、Pass 数、丢帧、降采样、动态质量 |
| 预设 | 参数 JSON 导出/导入、IndexedDB 保存/加载/删除、内置 标准绿幕 / 蓝幕 / 低光照 |
| 导出 | 参数 JSON、遮罩 PNG、合成 PNG、对比信息 TXT 报告 |

## 渲染管线（WebGL 多 Pass）

工作分辨率 = 视频分辨率 × 降采样系数，所有处理在离屏 FBO 纹理间 ping-pong：

```
视频纹理
  → Pass 1 场景采集
  → Pass 2 背景模糊链（4×3×3 高斯，仅“原视频模糊”背景）
  → Pass 3 色度键 + 溢色抑制 + 前景调色（输出 rgba，a=前景遮罩）
  → Pass 4.. 形态学（腐蚀/膨胀/边缘收缩，3×3 min/max，作用于 alpha）
  → Pass .. alpha 3×3 高斯
  → Pass .. 遮罩精修（羽化 smoothstep + 邻域降噪 + 半透明保留）
  → Pass .. 前背景统计（每 30 帧，16×16 降采样回读，驱动光照/色彩匹配）
  → Pass N 背景合成
  → 三路视口 blit（原始 / 棋盘遮罩 / 合成）
```

主画布三路视口直接作为“分屏对比”和“放大镜”的取图源（`preserveDrawingBuffer`）。

## CPU 回退

右侧面板可随时切到 `CPU Canvas`：纯 JS 逐像素实现同样的色度键/溢色/调色/形态学/加权高斯/降噪/合成，工作分辨率长边封顶 480px 以保证实时。WebGL 初始化失败时自动回退。

**两引擎公式对齐**：CPU 端的逐像素数学全部集中在 `js/keying.js`，与 `js/gl/shaders.js` 的 GLSL 逐式对应——三种色度空间的距离公式、`smoothstep` 键控斜坡、4/2/1 加权 3×3 alpha 模糊、形态学顺序（erode→dilate→shrink）、精修（羽化半宽 `feather*0.045`、降噪 snap `0.12`、半透明区间 `0.18..0.82`）、溢色边缘曲线与调色系数完全一致；每个 Pass 边界同样按 RGBA8 量化。因此相同参数下切引擎只有分辨率差异，遮罩边缘与抠净度不应有可见差别。

## 对照测试

零依赖，使用 Node 内置 test runner（需 Node ≥18）：

```bash
npm test
# 或：node --test tests/
```

- `tests/keying-parity.test.mjs` — WebGL/CPU 抠像一致性：
  - **A. 逐像素数学**：独立直译 `shaders.js` 中的 GLSL（rgb2yuv / rgb2hsv / 三种距离 / 键控斜坡 / 溢色+调色），在 8-bit 颜色网格（33³ 色）×多组键色/阈值上与 `js/keying.js` 逐值对照，误差 < 1e-6；
  - **B. 静态契约**：直接读发货源码，断言 RGB 权重 `(1.2,1.0,1.2)*0.8`、HSV/YUV 权重、`smoothstep` 斜坡、精修常量、高斯核、形态学顺序、tint 系数等不再漂移（回归旧公式会直接失败）；
  - **C. 整帧管线**：合成带噪声软边缘的绿幕帧，跑完整 alpha 管线（7 组 RGB/YUV/HSV 参数），两实现逐像素 ≤1 LSB；并用修复前的旧 RGB 公式做回归演示。
- `tests/cpu-engine.smoke.test.mjs` — 用最小 canvas 桩跑完整 `CPUEngine.render()`，验证集成路径输出合法帧。

浏览器侧手动验证：打开页面 → 选 RGB 色度空间 → 在同帧暂停（或逐帧）下切换 `WebGL 多 Pass` / `CPU Canvas`，遮罩边缘与抠净程度应一致；YUV、HSV 同样核对。

## 目录结构

```
greenroom/
├── index.html
├── style.css
└── js/
    ├── main.js              # 主控：UI 绑定、主循环、性能、预设、导出
    ├── params.js            # 参数模型 + 内置预设 + JSON
    ├── keying.js            # CPU/测试共用的抠像数学（与 GLSL 逐式对齐）
    ├── db.js                # IndexedDB 预设存取
    ├── source.js            # 摄像头/文件/内置 canvas 测试源
    ├── layout.js            # 三路视口无缝布局 / cover 映射
    ├── gl/
    │   ├── shaders.js       # 全部 GLSL（键控/形态学/高斯/精修/合成/预览）
    │   └── GLEngine.js      # WebGL 多 Pass 引擎
    ├── cpu/
    │   └── CPUEngine.js     # 2D Canvas 逐像素回退（数学取自 keying.js）
    ├── ui/
    │   ├── compare.js       # 分屏对比 + 放大镜
    │   └── histogram.js     # alpha 直方图
    └── tests/               # node --test 对照测试（零依赖）
```

## 使用提示

- 默认是 YUV 色度平面键控（对光照不均更鲁棒）；绿幕布色不均时加大“平滑度”，有绿边时加“边缘收缩 + 边缘颜色校正”。
- 头发等半透明区域：降低“降噪”、勾选“半透明区域保留”、适当增大羽化。
- 性能吃紧时下调降采样或开启“动态质量调节”（低于 ~26fps 自动降级）。
- 所有参数都可导出 JSON 复用；内置预设只覆盖算法参数，不替换背景素材。
