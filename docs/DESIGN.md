# 设计文档：跨端文档扫描 Demo

- 状态：与当前代码同步（Expo SDK 58 / RN 0.88）
- 读者：接手本仓库的客户端 / 原生 / C++ 开发者
- 使用说明见 [../README.md](../README.md)

---

## 1. 背景与目标

做一个 CamScanner 类的文档扫描演示，覆盖 Android、iOS、HarmonyOS 三个平台：

1. **一份算法**：滤镜只写一遍 C++，三端复用，不允许各平台各写一套。
2. **原生性能**：像素处理走编译后的 C++，不在 Hermes 里跑逐像素 JS。
3. **无原生模块也能用**：Expo Go / 鸿蒙 H5 场景下有等价的 Canvas 回退。
4. **完整闭环**：拍照或批量导入 → 应用内相册选择（带序号/预览）→ 多页编辑
   （继续导入、排序、逐页滤镜）→ 保存 → 历史 → 逐页查看 / 导出到相册 / 删除。
5. **图片转 PDF**：多选导入 → 排序 → 生成 → 分享；生成前后都能对单页做增强/旋转。
6. **自动切边与取字**：导入/拍照后自动找四角并拉正（端侧模型），可再手动微调；
   扫描页能端侧识别文字并按行编成可编辑的文本。
7. **可验证**：每个平台都能在没有真机的条件下验证桥接与算法。

## 2. 非目标

- 不做云端同步：识别用的是端侧模型，只有在「我的」里配置了识别服务、并且手动点
  「裁剪」或端侧 OCR 不可用时，才把当前图片发给该服务（见 §15.3）。
- 手写去除已实现（按饱和度涂白），但批注仍未实现：字段已预留，渲染层待做。
- 不做不限页数的 PDF：Android/iOS 已有原生 `createPdf`（逐页写、不占整份
  HTML），但页数上限仍沿用 `pdfLimits.ts` 的 15–60 页，暂不放开；Expo Go 的
  expo-print 兜底路径依旧受整份 HTML 进内存的限制。详见
  [EDGE_DETECTION.md](EDGE_DETECTION.md) §6（鸿蒙端已实现流式 writer）。
- 不追求上架质量：Release APK 用 debug keystore 签名，iOS 产物未签名。
- 不提供账号、权限体系或加密存储。

---

## 3. 总体架构

```
┌──────────────────────────── JS / UI 层 ────────────────────────────┐
│ App.tsx（路由状态机）                                               │
│   HomeScreen / CameraScreen / EditorScreen / DocumentScreen        │
│   PdfScreen（排版 / 生成 / 分享）                                   │
│                                                                    │
│ EditorScreen.runFilter()                                           │
│   ├─ isNativeFilterAvailable() ──► filterWithNative()              │
│   └─ 否则 ───────────────────────► filterWithCanvas()              │
│                                                                    │
│ imagePipeline：resizeImage / rotateImage / warpPerspective         │
│   └─ 原生几何变换（C++，文件进出）；Expo Go 退回 Canvas/manipulator │
│                                                                    │
│ pdf.ts：原生 createPdf（PdfDocument）→ document.pdf                │
│         无原生库时回退：逐页 base64 → HTML → expo-print            │
│ documentDetection.ts → nativeDocumentDetector.ts：端侧四角检测        │
│ detectionServer.ts：配置了服务端时手动裁剪走 model_1228              │
│ ocrLocal.ts / ocrServer.ts：端侧 PP-OCRv4 / Vision，兜底 /api/ocr    │
└───────────────┬──────────────────────────────┬─────────────────────┘
                │ Expo Modules API             │ postMessage / injectJS
┌───────────────▼──────────────┐   ┌───────────▼─────────────────────┐
│ ImageCore 原生模块            │   │ 隐藏 WebView（1×1）              │
│  Android: Kotlin + JNI       │   │  Canvas 2D + 同一套滤镜公式        │
│  iOS: Swift + ObjC++         │   │  JPEG data URL 返回              │
│  Harmony: ArkTS + NAPI       │   └─────────────────────────────────┘
└───────────────┬──────────────┘
                │ process_pixels(uint32_t*, w, h, id)
┌───────────────▼────────────────────────────────────────────────────┐
│ modules/image-core/common/image_core.{h,cpp}                       │
│ 纯 C++17，无平台依赖：滤镜 + 几何变换（warp/resize/rotate）          │
│ 只改像素，不解码/编码                                              │
└────────────────────────────────────────────────────────────────────┘
```

鸿蒙不是 React Native 运行时，因此 UI 换成 ArkWeb 承载 H5，滤镜仍走同一份 C++：

```
ArkWeb(H5) ──javaScriptProxy──► Index.ets ──► ImageCoreService.ets
                                                   │ ImageKit 解码/编码
                                                   ▼
                                             NAPI ──► image_core.cpp
```

---

## 4. 分层与模块职责

| 层 | 文件 | 职责 |
|---|---|---|
| 入口 / 路由 | `App.tsx` | 路由状态机、底部 tab、文档/PDF 列表增删、权限与相册入口 |
| 页面 | `src/screens/*` | 首页、全部文档、工具箱、我的、相机、相册选择器、扫描编辑器、单页编辑器、详情、PDF 排版、PDF 阅读器 |
| 底部导航 | `src/components/TabBar.tsx` | 五个入口：首页 / 全部文档 / 相机（凸起主按钮）/ 工具箱 / 我的 |
| 编排 | `src/lib/imagePipeline.ts` | 资源解析、尺寸读取、缩放、旋转、读 base64 |
| 引擎选择 | `src/lib/filterNative.ts` | 探测原生模块、文件路径转换、调用与计时日志 |
| 回退引擎 | `src/lib/filterEngine.tsx` | 隐藏 WebView、消息协议、超时、Canvas 滤镜 |
| 算法配置 | `src/lib/filters.ts` | 算法 key / 中文名 / UI 顺序 / 微调范围，唯一配置入口 |
| 裁剪几何 | `src/lib/crop.ts` | 归一化四角、凸性、面积、整图判定（纯函数） |
| 页面文件 | `src/lib/pageStore.ts` | 页面导入/编辑/删除的文件操作，扫描与 PDF 共用 |
| 扫描存储 | `src/lib/storage.ts` | 扫描文档索引、草稿目录、旧版单图记录迁移 |
| PDF 生成 | `src/lib/pdf.ts` | 页数上限、分辨率策略；优先原生 `createPdf`，回退 HTML + expo-print |
| PDF 保存 | `src/lib/savePdf.ts` | Android SAF 目录选择 / iOS 分享面板，统一保存结果 |
| PDF 存储 | `src/lib/pdfStorage.ts` | 项目目录、索引，页面文件委托给 `pageStore` |
| 命名 / 时间 | `src/lib/format.ts` | 从 URI 推导文档名、列表时间格式 |
| 裁剪组件 | `src/components/CropOverlay.tsx`、`CropLoupe.tsx` | 四角/四边手柄、就近抓取、放大镜 |
| 切边接口 | `src/lib/documentDetection.ts` | 四角检测 / 批量 / 透视变换的 JS 契约，检测器可插拔 |
| 端侧切边 | `src/lib/nativeDocumentDetector.ts` | 接 `detectFile`：Android DocCornerNet ONNX，iOS Vision |
| 服务端切边 | `src/lib/detectionServer.ts` | `POST /api/edgeDetector`（model_1228），JPG 90% 压缩，8 s 超时 |
| OCR | `src/lib/ocrLocal.ts`、`ocrServer.ts`、`ocrStorage.ts` | 端侧 PP-OCRv4 / Vision，服务端 `/api/ocr` 兜底，结果按页存盘 |
| 类型 | `src/types.ts` | `FilterKey`、`DocPage`、`ScanDoc`、`PdfDoc`、`DocumentQuad`、文案 |
| 原生桥 | `modules/image-core/*` | Expo 模块封装、平台解码/编码、JNI/NAPI |
| 算法 | `modules/image-core/common/*` | 纯 C++ 像素处理 |
| 鸿蒙 | `harmony/` | ArkTS 工程、ArkWeb H5 编辑器、NAPI 注册 |

约束：`src/app/` 目录不存在，路由不用 Expo Router；这是当前实现，不是规范（见 §14 ADR-6）。
非路由代码全部放在 `src/` 下。

### 4.1 各模块的设计方式与取舍

这一节回答「为什么这样切、代价是什么」。每个模块按 **做法 → 优点 →
代价与规避** 写；具体时序见 §5，实测数字见 §13。

#### 4.1.1 共享 C++ 内核 `modules/image-core/common/`

**做法**：纯 C++17，无 STL 容器、无平台头文件。输入输出都是同一个
`uint32_t*`，滤镜原地修改；几何变换不分配内存，先 `*_output_size` 拿尺寸，
调用方分配 `dst` 再调 `*_pixels`。`Filter` 用固定 id，`version()` 返回字符串；
所有函数先校验指针/宽高，失败返回错误码而不是抛异常。

**优点**

- 一套像素公式，四个平台（Android / iOS / 鸿蒙 / 桌面）行为一致；
- 原地处理，大图也只有「源缓冲 + 输出缓冲」两份，没有中间拷贝；
- 不依赖 Bitmap / CoreGraphics / ImageKit，宿主侧能直接编译成 Node-API 或
  C ABI 做单元测试（§13.1、§13.2 的对比就是这样跑的）；
- 算法与解码/编码解耦，换编码格式（JPEG → WebP）不动算法。

**代价与规避**

- 每加一个平台就要写一层桥，桥的 bug 只能靠契约测试发现 → `version()` +
  跨端契约脚本检查函数名、filter id、返回字段；
- 用不上平台图像库的加速（vImage / Skia / ImageKit）→ 当前 1050×1400 的滤镜
  只要 8–20 ms，真需要时可在桥内替换；
- 单线程、无 SIMD，复杂度 O(W·H) → 靠上游把尺寸限制在 1400–1600 px。

#### 4.1.2 像素契约：`0xAARRGGBB`

**做法**：C++ 只认小端 `uint32_t`，值为 `0xAARRGGBB`。各平台主动要求这个
布局：Android `ARGB_8888` 的 int 数组、iOS
`premultipliedFirst | byteOrder32Little`、鸿蒙 `BGRA_8888`（字节序 B,G,R,A）、
桌面 `ic_process_rgba` 内部换 R/B。

**优点**：零转换；`getPixels` / `readPixelsToBuffer` / `writeBufferToPixels`
都能原地读写，省掉一次全图拷贝；四个平台的桥可以互相参照。

**代价**：契约错了不会崩，只会红蓝互换或整图偏色，很难一眼发现；iOS 是预乘
alpha，不透明文档无影响，带透明的 PNG 会有误差；Canvas 回退是 RGBA，无法
共用这份缓冲区。

**规避**：契约写进每个桥的注释；宿主测试固定灰阶/二值输出；跨端脚本检查
filter id 与字段名。透明图暂不支持（§17）。

#### 4.1.3 四个桥：JNI / ObjC++ / NAPI / C ABI

**做法**：桥只做三件事——解码成像素、调内核、编码写文件。Android 用
`GetIntArrayElements` 拿裸指针，只读源数组用 `JNI_ABORT` 释放；iOS 的 C 桥把
`double quad` 转 `float`，`.mm` 直接 `#include` 内核源码（CocoaPods 不编译 pod
目录外的文件）；鸿蒙 NAPI 接受 `ArrayBuffer`，长度不足抛 `RangeError`；桌面
导出稳定的 `ic_*` C ABI。

**优点**：桥很薄（每个 300–500 行），出问题容易二分；文件进出，大图不经过
base64；错误码统一（0 成功 / 负数失败），上层只需要 `check(result == 0)`。

**代价**：同一套「解码 → 内核 → 编码」写了四遍（平台 API 不同，无法复用）；
iOS 只能在 macOS runner 上编译，Windows 本地无法验证；鸿蒙的 `PixelMap` 与
`ArrayBuffer` 之间还多一次读写。

**规避**：公开签名由 `ImageCoreModule.ts`、`index.d.ts`、契约脚本三处约束；
尺寸计算、角度规整等逻辑尽量放进共享代码或共享常量。

#### 4.1.4 Expo 模块封装 `modules/image-core/src/ImageCoreModule.ts`

**做法**：`requireNativeModule('ImageCore')` 放在 `try/catch` 里，失败时记录
`loadError`，`isImageCoreAvailable()` 返回 false；每项能力用
`typeof nativeModule?.xxx === 'function'` 探测（旧安装包可能没有
`processFileEx` / `warpFile` / `createPdf`）。

**优点**：Expo Go 与旧安装包不改 JS 就能降级；UI 层只看能力，不看平台；
类型集中在一处。

**代价**：TS 接口与 Kotlin / Swift / ArkTS 实现手工同步，新增方法忘了写可选
声明，TS 不会报错；`requireNativeModule` 的失败原因被压缩成一个布尔值。

**规避**：`loadError` 暴露给调试页；契约脚本检查方法名；新增能力一律做成
可选方法，调用点先探测。

#### 4.1.5 引擎选择与日志 `src/lib/filterNative.ts`

**做法**：原生可用时文件进文件出，输出到 `cacheDirectory/filter-*.jpg`；
日志打印 decode / process / encode / total，带 adjust 参数。

**优点**：UI 不关心实现；耗时字段能直接定位瓶颈（裁剪从 5.6 s 降到 284 ms
就是靠它发现的）；输出文件名带自增序号，同毫秒并发不会互相覆盖。

**代价**：产生大量缓存文件，依赖系统回收；URI ↔ 路径转换散落在多个模块；
release 也会打日志。

**规避**：所有临时产物都有明确删除点（`pageStore`、`ScanEditor` 的 cleanup）；
`toFilePath` / `toFileUri` 只保留一份实现。

#### 4.1.6 Canvas 回退 `src/lib/filterEngine.tsx`

**做法**：App 根部挂一个 1×1 透明 WebView，页面内用 Canvas 2D 实现同一套
公式；消息走 `postMessage`，1.5 s 没响应再用 `injectJavaScript` 补发，单次
30 s 超时。

**优点**：Expo Go / 旧安装包也能用；WebView 有 JIT，比 Hermes 纯 JS 快两个
数量级；同一套公式方便做像素级对比（§13.2）。

**代价**：base64 往返（1 MP ≈ 5 MB 字符串）、WebView 常驻内存、时序复杂；
浮点与整数的取整差异导致与原生不完全一致。

**规避**：只在原生不可用时启用；差异有量化测试；请求 id + 超时防止悬挂。

#### 4.1.7 图像流水线 `src/lib/imagePipeline.ts`

**做法**：`prepareBase`（最长边 1400）、`resizeImage`（原生 C++ 优先，
`expo-image-manipulator` 兜底）、`resizeToWidth`（按宽换算成最长边）、
`rotateImage`、`warpPerspective`、`readBase64`、URI 与路径互转。

**优点**：几何操作集中在一个文件，调用点不需要知道原生是否可用；C++ 路径
文件进出，不经过 base64；缩略图也走同一份箱式/双线性缩放，不会出现「主图
清晰、缩略图糊」。

**代价**：一个模块同时承担准备、几何、IO 三件事，职责偏杂；兜底路径与原生
路径的输出质量/耗时不同。

**规避**：几何函数统一返回 URI，调用方负责删除临时文件；只有原生不可用时
才降级。

#### 4.1.8 页面文件生命周期 `src/lib/pageStore.ts`

**做法**：每页最多三份文件：`src`（原图或裁剪结果，永不覆盖）、`page`
（按算法渲染的结果）、`thumb`（220 px）。`replacePageSource*` 先写临时文件
再替换；缩略图由 `resizeToWidth` 生成，替换成功后删旧文件。

**优点**：原图始终可回溯（对比、换算法重算）；渲染失败不会破坏源文件；
缩略图与主图分离，列表滚动不解大图。

**代价**：一页最多三份文件，30 页约占 30–60 MB；替换路径多，漏删会积累
垃圾；`copyAsync` 只接受 `file://`。

**规避**：所有写入集中在本模块；删除时同步清理旧渲染/缩略图；缓存目录由
系统回收。

#### 4.1.9 索引与存储 `storage.ts` / `pdfStorage.ts`

**做法**：`index.json` 记录元数据与页顺序，图片文件放同目录；读取时对每个
字段做 `sanitize`（旧版本或手改都可能非法）；PDF 页复用 pageStore 的文件
结构。

**优点**：索引小、可读、易迁移；文件即数据，不依赖数据库；旧记录能容错。

**代价**：没有锁和事务（单 JS 线程下靠串行 `await` 保证）；写到一半被杀会
留下孤儿文件；索引与文件可能不一致。

**规避**：写临时文件 + rename；读取时过滤不存在的页；孤儿文件靠缓存清理。

#### 4.1.10 PDF 生成与保存 `pdf.ts` / `pdfStorage.ts` / `savePdf.ts`

**做法**：优先原生 `createPdf`（Android/iOS 逐页画进 PDF），否则 HTML +
`expo-print`。保存分平台：Android 用 SAF 目录选择器，iOS 用分享面板；
写目标 URI 走 `expo-file-system` 新 API。鸿蒙对应 `PdfWriter` + `PdfSave.ets`。

**优点**：不依赖服务端；原生路径内存只与单页有关（解码前先降采样）；保存
不需要存储权限。

**代价**：两套实现（原生 / HTML）版式不完全一致；iOS 没有「保存到文件夹」；
SAF 的 `canWrite()` 不可信，必须用新 API。

**规避**：页数上限 30；逐页解码；保存逻辑集中到 `savePdf.ts` / `PdfSave.ets`，
两个入口共用。

#### 4.1.11 扫描编辑器 UI `ScanEditorScreen` + `CropOverlay` + `CropLoupe`

**做法**：页面状态（页、当前页、算法、旋转、微调、裁剪、忙碌）都在
`ScanEditorScreen`；纯几何（归一化坐标、凸性、面积、整图判定）在 `crop.ts`；
手柄绘制与手势在 `CropOverlay`（就近抓取、四角/四边、触摸区外扩）；放大镜
单独一层，固定在手柄上方或下方 88 px、2.6×，超出图片的部分透明。

**优点**：归一化坐标让裁剪框与图片尺寸、旋转、屏幕大小解耦；放大镜在最外层，
不会被舞台的 `overflow: hidden` 裁掉；镜心与手柄固定偏移、1:1 跟手、不做
夹取，所以不跳；非凸四边形立即变红并禁用「确定」。

**代价**：`ScanEditorScreen` 很大（约 2000 行），状态多、闭包多；手势依赖
`onLayout`，首帧可能拿不到尺寸；放大镜是纯 UI 重绘，低端机可能掉帧。

**规避**：纯函数抽到 `crop.ts` 并可单测；关键状态用 ref 镜像，避免闭包读到
旧值；裁剪/旋转产物直接走原生文件，不把像素搬进 JS。

#### 4.1.12 鸿蒙服务层 `harmony/.../ImageCoreService.ets`

**做法**：与 Android / iOS 同构的 7 个方法：`processFile`、`processFileEx`、
`warpFile`、`resizeFile`、`rotateFile`、`makeThumbnail`、`version`。解码统一
走 `image.createImageSource(fd)`，请求 `BGRA_8888`，可带 `desiredSize`
降采样；编码走 `ImagePacker`；句柄在 `finally` 里 `release` / `close`。

**优点**：接口、参数、耗时字段与 RN 端一一对应；降采样在解码阶段完成，12 MP
图不会先展开再缩小；缩略图复用 `resizeFile`，与 RN 的 `resizeToWidth` 是同一
份 C++ 缩放。

**代价**：ArkTS 严格模式不能用 `any` / 结构化类型，桥接代码比 Kotlin 啰嗦；
`PixelMap` 写回多一次 `writeBufferToPixels`；鸿蒙没有可用的模拟器/真机（§17），
只能靠宿主 NAPI 测试 + 编译通过来验证。

**规避**：NAPI 函数顺序、参数、错误码与 Android JNI 保持一致；可测的部分
（内核、PdfWriter、H5 协议）都放到宿主侧跑。

#### 4.1.13 鸿蒙 H5 编辑器 + `Index.ets` 桥

**做法**：UI 是一份纯 HTML/CSS/JS（`rawfile/index.html`），布局与交互对照
RN 的 `ScanEditorScreen`；ArkTS 注入 `nativeBridge`，H5 用
`{id, op, ...}` 请求，ArkTS **串行**处理并通过 `window.__onNativeResult`
回推。op 覆盖 `sample / pick / base / render / thumbs / warp / read / delete /
pdf / saveImages / version`。图片用 data URL 显示，处理始终是文件路径。

**优点**：鸿蒙不必重写一套 ArkUI 组件，H5 与 RN 可以逐项对照；算法仍在 C++，
H5 不碰像素；只有一条请求/响应通道，加 op 很容易；`withData` 让非当前页
不回传 base64。

**代价**：多一层 WebView 协议与序列化；data URL 比 `file://` 多一次 base64，
大图预览有几十毫秒开销；ArkWeb 对沙盒 `file://` 的支持不可靠，只能走 data
URL；调试要同时看 ArkTS 日志和 Web 控制台。

**规避**：请求带 id + 超时；ArkTS 串行处理，避免并发解码把内存峰值放大；
H5 只缓存当前页的图像数据；缩略图一次请求批量生成。

#### 4.1.14 桌面端 C ABI + CLI + Electron

**做法**：C ABI（`ic_*`）稳定、无异常、无全局状态；CLI 用 stb 解码，按扩展名
编码；Electron 只 `spawn` CLI，渲染进程 `sandbox + contextIsolation`，
`preload` 暴露少量 IPC。

**优点**：算法可被 Python / Java / Qt 直接调用；UI 崩溃不拖垮算法；打包后
目标机器不需要 Node / VC 运行库。

**代价**：每次调用起一个进程（几十毫秒）；Electron 包体大；桌面与移动端
UI 不共享。

**规避**：CI 覆盖 C++ / CLI / Python / JNI 与 Electron 语法检查；动态库与
CLI 放进 `resources/`。

#### 4.1.15 路由与状态 `App.tsx`

**做法**：联合类型 `Route` + `useState` 状态机，不引入导航库；文档/PDF 列表
状态提升到根部，页面只拿 props。

**优点**：路由就是数据，返回/恢复容易推理；没有导航依赖，Expo Go 里一致。

**代价**：深链、手势返回、栈动画都要自己写；页面变多后 `App.tsx` 会变重。

**规避**：暂只做单栈（ADR-6）；迁移路径见 §15.4。

#### 4.1.16 取舍总表与被否决的方案

| 决策 | 选择 | 主要收益 | 主要代价 |
|---|---|---|---|
| 算法放哪 | 共享 C++ | 四端一致、可宿主测试 | 每端一层桥 |
| 原生失败怎么办 | WebView Canvas | Expo Go 可用 | base64 + 两套公式 |
| 像素怎么传 | 文件 I/O | 无 base64、内存低 | 需要临时文件管理 |
| 鸿蒙 UI | H5 + ArkWeb | 复用 RN 的交互设计 | 多一层协议 |
| PDF | 原生优先 | 快、内存低 | 两套版式 |
| 路由 | 状态机 | 简单、无依赖 | 无深链/手势返回 |
| 缩略图 | 同一 C++ resize | 清晰、一致 | 每页多一次解码 |

被否决的方案：

- **纯 JS / Hermes 逐像素**：1 MP 要 1–2 分钟（§9.1），不可用；
- **WASM**：多一份运行时和首包体积，而 C++ 已经可以直接连桥；
- **每个平台各写一套算法**：短期快，长期必然漂移；
- **鸿蒙用 ArkTS 原生 UI**：要重写全部交互，和 RN 的 UI 也无法逐项对照；
- **索引放 SQLite**：数据量很小，JSON 更易读、易迁移；
- **把预览图也常驻成 base64**：30 页会多占约 10 MB JS 堆，按需回传即可。

---

## 5. 数据流与时序

### 5.1 输入

| 来源 | 实现 | 拿到的 URI |
|---|---|---|
| 拍照 | `CameraView.takePictureAsync({ quality: 0.9 })` | 缓存目录文件 URI |
| 相册（扫描） | `PhotoPickerScreen`：`MediaLibrary.getAssetsAsync` 分页列图，`getAssetInfoAsync` 取 `localUri` | 缓存目录 `file://`（异常时退回 `content://`） |
| 相册（PDF） | `ImagePicker.launchImageLibraryAsync`（旧路径，未迁移） | `file://` 或 `content://` |
| 示例 | `Asset.fromModule(require(...))` + 原生复制 | 缓存目录 `file://` |

示例资源在独立安装包里的处理见 §12.3。

### 5.2 进入编辑器

```
EditorScreen mount
  └─ prepareBase(sourceUri)                    // 最长边 > 1400 则等比缩小
       ├─ Image.getSize(uri)
       └─ manipulateAsync(resize, JPEG 0.92)
  └─ setCurrentUri(prepared) + setProcessing(true)
  └─ 滤镜 effect 触发
```

缩放放在滤镜之前，目的：

- Canvas 路径要传 base64，尺寸直接决定内存与 WebView 开销；
- 原生路径 JPEG 编码耗时与像素数近似线性；
- 1400 px 对手机查看足够，保存体积可控。

### 5.3 滤镜执行

```
filter effect（依赖 currentUri / filter）
  ├─ filter === 'original' → 直接显示 currentUri，不处理
  ├─ ++reqId，捕获 myReq
  ├─ 等 30ms（确保「处理中」遮罩先渲染）
  ├─ runFilter(currentUri, filter)
  │    ├─ 原生可用：filterWithNative()
  │    │    ├─ 去掉 file:// → 输入路径
  │    │    ├─ 输出 cacheDirectory/filter-<filter>-<ts>.jpg
  │    │    └─ processFile(input, output, filter, 92)
  │    └─ 否则：readBase64 → filterWithCanvas → data URL
  ├─ myReq === reqId.current 才 setProcessed
  └─ finally（未取消时）setProcessing(false)
```

竞态处理：

- `reqId` 单调递增，旧请求的结果直接丢弃；
- effect 清理函数置 `cancelled = true`，卸载后不 setState；
- **不取消**已经进入原生的计算；快速连点会浪费一次计算，但不会显示错图。

保存时如果 `processed.key === filter` 复用结果，否则重新跑一次滤镜，避免拿旧图保存。

### 5.4 导出与退出

扫描编辑器是「一次性导出」工具，不再往应用内文档库写入 `ScanDoc`：

```
ScanEditorScreen 顶栏「分享」
  └─ generatePdf(pages) → 沙盒 <draftId>/<文档名>.pdf → Sharing.shareAsync

ScanEditorScreen 「保存所有图片」
  └─ 逐页 MediaLibrary.saveToLibraryAsync(page.uri)，带 x/n 进度

ScanEditorScreen 「保存成 PDF」
  └─ generatePdf → savePdfToUser()（Android SAF / iOS 分享面板）

ScanEditorScreen 顶栏「返回」
  └─ 确认「返回并放弃编辑？」→ onCancel(draftId)
       └─ discardScanDraft(draftId)   // 删除 scans/<draftId>/ 整个目录
```

顶栏中间的文档名可编辑，默认取第一张图片的文件名（`titleFromUri`，相册的
`filename` 优先于 URI 末段）；生成 PDF 时的文件名、保存到相册后的分享标题
都用它。旧的 `scans.index.v1` 与「最近扫描」列表仍可读取/删除历史文档，
但新流程不再新增记录。

### 5.5 导出

`DocumentScreen` 用 `expo-media-library/legacy` 的
`requestPermissionsAsync(true)` + 逐页 `saveToLibraryAsync(page.uri)`，
用本地计数生成「已导出 x / n 页」的结果提示。

### 5.6 图片转 PDF

```
handleCreatePdf（首页）
  └─ 创建空草稿 PdfDoc（defaultFilter = 'enhance'）→ 路由到 PdfScreen
     （空草稿不写索引；第一次导入时才由 PdfScreen.onUpdate 落库）

PdfScreen
  ├─ 顶部算法 chips → doc.defaultFilter
  ├─ ＋ 添加图片：ImagePicker 多选（orderedSelection，上限 = limits.pageLimit）
  │    └─ persistPdfPages(..., { filter: defaultFilter })  逐张：
  │         resizeImage(maxDim, quality, alwaysEncode)
  │           → copy 到 pdfs/<id>/src/<pageId>.jpg        // originalUri
  │           → filter != 'original' 时 applyFilter()
  │                → edited/<pageId>.jpg                   // uri
  │           → 220px 缩略图 → thumb/<pageId>.jpg
  │           → 释放上一张的引用
  ├─ 「对整个文档执行」→ 逐页 renderPageBase64() → savePageEdit()
  │    （从 originalUri 重渲染，保留每页 rotation；中途取消保留已完成页）
  ├─ ↑ ↓：交换数组元素 → applyPages → updatedAt = now → dirty
  ├─ ✕  ：确认后删除三份文件（原图/派生图/缩略图）
  ├─ ✎  ：路由到 EditorScreen（sourceUri = originalUri，手动模式）
  └─ 生成：
        generatePdf(pages.map(p => p.uri), pdfs/<id>/document.pdf)
          ├─ 逐页 readBase64 → 拼 HTML（一次只持有一页的文件内容）
          ├─ expo-print → 缓存 PDF
          ├─ move（失败 copy）→ *.tmp → 原子替换 document.pdf
          └─ Expo Go 无法复制时：重新打印并要求 base64，由 JS 写入沙盒
        → generatedAt = max(now, updatedAt) → dirty = false
        → 按钮变成「分享 PDF」（expo-sharing）
```

**三种算法模式**：自动（导入时使用 `defaultFilter`）/ 手动（✎ 只改一页）/
原图（`defaultFilter = 'original'`，或「全部恢复原图」）。三者都只写
`DocPage.uri` 与 `filter`，`originalUri` 保持不变。

**页数自适应**（`pdfLimits.ts`）：`Device.totalMemory` 分档到 15/25/35/50/60 页，
Android 再用 `Device.getMaxMemoryAsync()`（JVM 堆）收紧到最多 10/15/25/35/60 页，
`maxDim` 同时按内存上限降到 1200/1400/1600/1800 px。这样低端机不会因为
「整份 HTML + WebView 位图」OOM，高端机也不会被固定 50 页限制。上限一次探测、
进程内缓存，`initPdfLimits()` 在 App 启动时调用。

**dirty 判定**：`!pdfUri || generatedAt === null || updatedAt > generatedAt`。
页面增删、排序、单页编辑只更新 `updatedAt`，不删除旧 PDF——用户可以先看旧文件，
需要时再重新生成；重新生成失败时旧 PDF 仍然有效。

### 5.7 单页编辑（生成前后都可以）

```
PdfScreen ✎ → EditorScreen(sourceUri = page.originalUri,
                            initialFilter, initialRotation,
                            maxDim = 1800, showPageTools)
  ├─ prepareBase(originalUri, 1800)   // preparedRef，未旋转
  ├─ rotateImage(preparedRef, rotation)
  ├─ 滤镜预览（原生或 Canvas）
  └─ 保存 → savePageEdit()
        ├─ filter !== original 或 rotation !== 0
        │    → 写 pdfs/<id>/edited/<pageId>_<ts>.jpg
        ├─ 重新生成缩略图（.tmp → 原子替换）
        ├─ 删除旧的派生图（originalUri 永不删除）
        └─ 更新 DocPage → updatedAt 变化 → 回到 PdfScreen → 提示重新生成
```

非破坏式模型的三个不变量：

1. `originalUri` 只写一次（导入时），之后无论怎么编辑都不改；
2. `uri` 永远是「当前用于生成 PDF 的那张图」，可能等于 `originalUri`；
3. `filter` / `rotation` / `cropQuad` / `annotations` 是可回放的编辑参数，
   清空它们并把 `uri` 指回 `originalUri` 就等于恢复原图。

旋转总是从 `preparedRef`（未旋转的预处理图）重算，而不是在当前图上叠加，
避免多次 JPEG 编码累积损失。

批量应用（`renderPageBase64`，`src/lib/pageRender.ts`）与单页编辑共用同一套
顺序：`originalUri → rotateImage → applyFilter → savePageEdit`。区别只是入口：
批量对每页传入 `{ filter: defaultFilter, rotation: page.rotation }`，
所以结果与逐页手动操作完全一致，且重复执行不会叠加编码损失。批量过程逐页
串行，中间结果及时释放；取消时把已完成页一次性落库。

### 5.8 多页扫描：选择 → 编辑 → 继续导入

```
首页「导入图片」
  └─ PhotoPickerScreen（新建、独立路由）
       ├─ requestPermissionsAsync → getAssetsAsync({ mediaType:'photo',
       │     sortBy:[['creationTime', false]], first: 60 })
       ├─ 点选：selected 数组按选择顺序追加，格子上显示 index+1
       ├─ 划选：横向滑过一串格子批量选中/取消（PanResponder 捕获横向手势，
       │     按起止格子线性补区间；从已选格子起手则整段取消）
       ├─ 预览：已选图片全屏分页（initialScrollIndex + getItemLayout）
       ├─ onEndReached → after: endCursor 续页，按 id 去重
       └─ 完成：逐张 getAssetInfoAsync → localUri，并带上 asset.filename
                → onDone(uris, names)

App.goScanEditor(uris, names[0])
  └─ route = { scanEditor, draftId: Date.now(), sourceUris,
                title: titleFromUri(第一张的文件名) }
       └─ ScanEditorScreen(key = draftId)
            ├─ 顶栏：返回 ｜ 可编辑文档名 ｜ 分享
            │     文档名默认取第一张图片的文件名，可改；作为 PDF 文件名
            │     BackHandler 先让输入框失焦，再走裁剪/返回确认
            ├─ mount：importScanPages(draftId, initialUris,
            │     { filter: 'enhance', signal, onProgress })
            │       └─ importPages()（pageStore.ts，扫描/PDF 共用）
            │            resize → JPEG → scans/<id>/src/<pageId>.jpg   // originalUri
            │            滤镜 → scans/<id>/edited/<pageId>.jpg          // uri
            │            220px 缩略图 → scans/<id>/thumb/<pageId>.jpg
            │            单张失败回退原图，全部失败才报错并回滚已写文件
            ├─ 「继续导入」→ pickerOpen：在编辑器上层渲染同一个
            │     PhotoPickerScreen（limit = pageLimit - pages.length）
            │     完成 → addImages(uris, selectFirst=true) 追加到末尾
            ├─ 翻页：水平滑动（PanResponder，阈值 48px）或 ◀ / ▶
            ├─ 页码行右侧：「原图|对比」按钮（带分割图标，按住看原图），
            │     与 ◀ 页码 ▶ 同一水平线，位于「应用到所有页」上方
            ├─ 算法方块：SCAN_FILTERS（src/lib/filters.ts）→ 缩略图
            │     缩略图输入 = 当前页（含旋转）缩到 260px 的临时 JPEG，
            │     applyFilter 逐张出图（原生→文件 / Canvas→data URI），
            │     按 (pageId:rotation:source) 缓存，切页/裁剪/卸载删临时文件
            ├─ 点第一次：runEdits → renderPageBase64 → saveScanPage
            │     点第二次（同一算法）：进入微调面板
            │     微调预览：900px 中图 + applyFilter(..., adjust)
            │     确认：runEdits 写全尺寸结果
            ├─ 「应用到所有页」（默认勾选）：targets = pages，逐页串行重渲染
            ├─ 裁剪：CropOverlay（4 角点圆圈 + 4 边中点长条；就近抓取；
            │     触摸区域比图片外扩 CROP_GRAB_PAD，贴边手柄才能按到）
            │     放大镜由页面在最外层画（CropLoupe），跟手 1:1、可超出图片
            │     非凸四边形 → 边框变红 + 「无效区域」提示 + 确定禁用
            │     确定 → 原生 warpFile（文件进/文件出）→ 拷贝进 src/ → 重跑当前算法
            │            （Expo Go 无原生库时才走 warpWithCanvas + base64）
            ├─ 图像右上角 ✕：确认框「删除此页 / 重拍此页 / 取消」
            │     重拍 → picker(limit=1) → 新图替换该页源图，随后按原算法重渲染
            ├─ 旋转：通过 pagesRef 串行提交
            ├─ 保存所有图片：逐页 uri → MediaLibrary（显示已保存 x/n）
            ├─ 保存成 PDF：generatePdf(pages.uri) → savePdfToUser()
            │     Android：SAF 选文件夹（ACTION_OPEN_DOCUMENT_TREE）→ File.copy
            │     iOS：expo-sharing（含「存储到文件」）
            │     保存成功后可再走分享面板
            ├─ 分享：generatePdf(pages.uri) → Sharing.shareAsync
            └─ 返回：确认「返回并放弃编辑？」→ onCancel → 删草稿目录
```

关键点：

- **选择顺序即文档页序**：`selected` 是数组，不排序；取消选择会重排后续编号。
- **先落盘再编辑**：进编辑器前图片已按目标尺寸写进草稿目录，之后的算法/旋转
  只重渲染并原子替换派生的 `edited/` 文件，`originalUri` 永不改。
- **算法清单只有一处**：`src/lib/filters.ts` 的 `FilterKey` / `FILTER_LABELS` /
  `SCAN_FILTERS` 决定界面展示哪些算法、顺序和名称；UI 不再写死数组。
- **继续导入复用同一组件**：选择器作为编辑器的浮层子组件渲染，不经过系统
  Activity，返回键/取消不会让编辑器卸载，已导入页面不会丢。
- **文件名带时间戳**：每次保存派生图都写 `<pageId>_<ts>.jpg` 再删旧文件，
  避免 Fresco 按 URI 命中旧缓存。算法缩略图是缓存目录里的临时文件（原生路径）
  或 data URI（Canvas 兜底），只在编辑器存活期间有效。
- `pagesRef` 与 `setPages` 同步更新，异步导入/编辑回调始终基于最新数组提交；
  `busy` 非空时翻页、算法、工具按钮禁用，导入可取消。
- 微调参数存 `DocPage.adjust`；`savePageEdit` 只在旋转/算法/微调任一非默认时
  才重新编码，`filter=original && adjust=0 && rotation=0` 直接复用原图。

---

## 6. 像素契约与共享内核

### 6.1 内存布局

C++ 只接受 **ARGB_8888**：每个像素一个 `uint32_t`，小端序下内存字节顺序是
`B, G, R, A`，整数值为 `0xAARRGGBB`。

| 平台 | 构造方式 | 保证 |
|---|---|---|
| Android | `Bitmap.getPixels(int[])`（`ARGB_8888`、`inMutable`） | int 即 `0xAARRGGBB` |
| iOS | `CGContext`，`premultipliedFirst \| byteOrder32Little` | 小端 `uint32` 为 `0xAARRGGBB` |
| HarmonyOS | `PixelMap` 请求 `BGRA_8888`，`readPixelsToBuffer` | 字节序 `B,G,R,A` |
| Canvas 回退 | `ImageData`（`R,G,B,A`） | JS 侧自行按 RGBA 处理，不经过该契约 |

假设：所有目标平台都是小端 CPU（Android/iOS 的 ARM、x86 均满足）。

Alpha 约定：滤镜只改 RGB，A 原样保留。iOS 使用预乘 alpha，不透明文档没有影响；
带透明通道的图片会有预乘误差，本项目不处理（见 §17）。

### 6.2 接口

```cpp
namespace image_core {
enum Filter : int32_t {
  kOriginal = 0, kGray = 1, kBw = 2, kEnhance = 3,
  kShadow = 4, kDehand = 5, kHd = 6, kBrighten = 7,
  kSharpen = 8, kInkSave = 9, kInvert = 10,
};
void process_pixels(uint32_t* pixels, int32_t width, int32_t height, int32_t filter);
void process_pixels_ex(uint32_t* pixels, int32_t width, int32_t height, int32_t filter,
                       int32_t contrast, int32_t brightness, int32_t detail);

// 几何变换：warp（四角裁剪）/ resize / rotate
void warp_output_size(int32_t src_w, int32_t src_h, const float quad[8],
                      int32_t max_dim, int32_t* out_w, int32_t* out_h);
void warp_pixels(const uint32_t* src, int32_t src_w, int32_t src_h,
                 uint32_t* dst, int32_t dst_w, int32_t dst_h, const float quad[8]);
void resize_output_size(int32_t src_w, int32_t src_h, int32_t max_dim,
                        int32_t* out_w, int32_t* out_h);
void resize_pixels(const uint32_t* src, int32_t src_w, int32_t src_h,
                   uint32_t* dst, int32_t dst_w, int32_t dst_h);
void rotate_pixels(const uint32_t* src, int32_t src_w, int32_t src_h,
                   uint32_t* dst, int32_t degrees);

const char* version();
}
```

- `pixels == nullptr` 或宽高非正：直接返回。
- 未知 filter：按 original 处理。
- `process_pixels` 等价于 `process_pixels_ex(..., 0, 0, 0)`，保留旧 ABI。
- 几何变换不分配内存：先调 `*_output_size` 拿目标尺寸，调用方分配 `dst` 再调 `*_pixels`。
- `version()` 当前返回 `image-core/0.3.0`。

### 6.3 filter id 的跨端一致性

字符串到 id 的映射在四个地方重复（Android Kotlin、iOS Swift、鸿蒙 ArkTS、Canvas JS），
这是当前设计中最容易漂移的点：

| 字符串 | id | 字符串 | id |
|---|---|---|---|
| `original` | 0 | `brighten` | 7 |
| `gray` | 1 | `sharpen` | 8 |
| `bw` | 2 | `inksave` | 9 |
| `enhance` | 3 | `invert` | 10 |
| `shadow` | 4 | | |
| `dehand` | 5 | | |
| `hd` | 6 | | |

跨端契约脚本会检查这些字面量。新增算法时**四处都要改**，否则该平台会静默
退回原图（`filterId` 的 default 分支）。

---

## 7. 滤镜算法

记 `R,G,B` 为 0–255 整数，`clamp(x) = min(255, max(0, x))`。

### 7.1 亮度

- C++：整数近似 `lum = (299R + 587G + 114B) / 1000`（向下取整）。
- JS：浮点 `0.299R + 0.587G + 0.114B`。

两者在边界上可能差 1，是 §13 像素差异的主要来源之一。

### 7.2 灰度（gray）

```
lum = luma(R,G,B)
v   = clamp((lum - 128) * 1.15 + 128)
R' = G' = B' = v
```

对比度中心 128、增益 1.15：纸面提亮、墨迹略加深，同时避免纯灰阶过于平。

### 7.3 黑白（bw）

1. 对整图统计 256 桶亮度直方图；
2. Otsu 最大化类间方差：

```
σ²(t) = wB(t) * wF(t) * (μB(t) - μF(t))²
threshold = argmax σ²(t)
```

3. 二值化：`v = lum > threshold ? 255 : 0`。

Otsu 对文档（双峰分布：纸面 / 墨迹）效果好，且不需要调参。代价是多一次全图扫描，
复杂度 `O(2N + 256)`；额外内存只有 256×4 字节直方图。

注意：阈值用 `>` 而非 `>=`，与 JS 实现一致。

### 7.4 增强（enhance）

```
lum = luma(R,G,B)
if (lum > 165) {
    k  = min(1, (lum - 165) / 90) * 0.92
    c' = c + (255 - c) * k          // 纸面向白提亮
} else {
    c' = clamp((c - 128) * 1.28 + 128)  // 墨迹提高对比
}
```

`lum > 165` 是纸面/墨迹的经验分界。临界点两侧的输出不连续，所以原生与 Canvas
在 `lum ≈ 165` 附近可能差到 24（见 §13），这是算法本身的分段特性，不是实现 bug。

### 7.5 文档类算法（shadow / dehand / hd / brighten / sharpen / inksave / invert）

这些算法都是逐像素 + 可分离盒式模糊，C++ 与 Canvas 使用同一套公式：

| key | 名称 | 做法 |
|---|---|---|
| `shadow` | 去阴影 | 亮度做半径 `max(6, min(w,h)/8)` 的局部背景模糊，`gain=min(3.5, 235/max(bg,24))` 后逐通道相乘 |
| `dehand` | 去除手写 | `mx>70 && (mx-mn)/mx>0.32` 判为彩色笔迹，直接涂白（启发式，不通用于彩色印刷物） |
| `hd` | 高清 | 1%/99% 分位亮度拉伸，再以半径 2、强度 0.55 做亮度反锐化 |
| `brighten` | 增亮 | `255-(255-c)*0.76`；亮度 >205 的像素再向白色推 |
| `sharpen` | 增强锐化 | 半径 1、强度 1.0 的亮度反锐化 |
| `inksave` | 省墨 | `45 + c*210/255`，压缩动态范围、保留可读性 |
| `invert` | 反色 | `255-c` |

`box_blur` 是可分离滑动窗口（O(N)，与半径无关）；`unsharp` 只处理亮度差，
再同量加到 RGB，避免通道间出现彩边。

### 7.6 第二步微调（adjust）

`process_pixels_ex(pixels, w, h, filter, contrast, brightness, detail)` 在算法之后执行：

```
brightness: c' = c + brightness * 2.55
contrast:   c' = (c' - 128) * (259*(C+255)) / (255*(259-C)) + 128,  C = contrast * 2.55
detail:     亮度反锐化，半径 1，强度 detail/100 * 1.2
```

范围：`contrast/brightness ∈ [-50,50]`，`detail ∈ [0,100]`；桥接层与 JS 都会夹紧。
旧的 `process_pixels` 保留，等价于 `process_pixels_ex(...,0,0,0)`，
因此旧原生库仍可加载（JS 侧用 `processFileEx?` 判断）。

### 7.7 四角透视裁剪（warp）

共享 C++ 的 `warp_output_size` / `warp_pixels`：先用四点对应关系解 8×8
单应矩阵（高斯消元，与旧 Canvas 实现同一套公式），把目标矩形的每个像素
反向映射到源四边形，做双线性采样，越界填白。

- 输出宽取 `|TL-TR|` 与 `|BL-BR|` 的较大者，高取 `|TL-BL|` 与 `|TR-BR|` 的较大者；
  最长边超过 `maxDim`（1600）时整体等比缩小。
- 采样用整数像素下标而不是像素中心，和旧 Canvas 版逐像素一致：
  整图裁剪时输出与源图完全相同，边缘也不会因为采样到图外而出现白边。
- 非凸四边形在 UI 层就被拦下（红色边框 + 「确定」不可用），C++ 只保证不崩溃。

坐标约定：归一化到**当前显示方向**的原图（`originalUri` + 页面 rotation），
顺序 TL → TR → BR → BL；`crop.ts` 的 `quadToArray()` 直接给出桥接层要的 8 个数。

裁剪确认后：

1. 原生 warp 结果先落在缓存目录，再 `copyAsync` 成新的
   `src/<pageId>_crop_<ts>.jpg`——**不经过 base64**；
2. 旋转已经烘焙进像素，页面 `rotation` 归零；
3. 若原页面有算法/微调，基于新原图重新渲染一次 `edited/`；
4. 旧原图与旧派生图删除——裁剪是唯一不可回放的编辑。

Expo Go 没有原生模块时才退回 Canvas 的 `warpWithCanvas()`（base64 进出），
这条路径只用于兼容，不再是大图裁剪的默认实现。

### 7.8 缩放与旋转（resize / rotate）

- `resize_output_size` / `resize_pixels`：等比缩到最长边 `maxDim`，**不放大**
  （未超限时原样返回尺寸，只重新编码）；缩小走盒式平均（目标像素取源图对应
  区块均值，降采样不锯齿），放大走双线性。
- `rotate_pixels`：只支持 90 / 180 / 270 顺时针；90 / 270 交换宽高，
  180 是内存逆序复制。与 `expo-image-manipulator` 的 `rotate`（正数顺时针）同向。
- JS 侧 `imagePipeline.resizeImage` / `rotateImage` 优先进原生，
  `expo-image-manipulator` 只在 Expo Go 里兜底。
- 缩略图（列表 220 px 宽）走 `resizeToWidth()`：JS 只把「按宽缩放」换算成目标
  最长边，像素处理仍交给同一个 `resize_pixels`。导入、保存、裁剪后的缩略图
  都因此不再调用 `expo-image-manipulator`，整条图片处理链只保留一份 C++ 实现。

### 7.9 原图（original）

C++ 空操作；JS 直接返回输入。保留该枚举是为了契约完整和 UI 一致性。

### 7.10 复杂度

| 滤镜 | 时间 | 额外内存 |
|---|---|---|
| gray | O(N) | O(1) |
| bw | O(N) + O(256) | 1 KB 直方图 |
| enhance | O(N) | O(1) |
| shadow / hd / sharpen / detail | O(N)（盒式模糊可分离，与半径无关） | 2 个单通道缓冲 |
| 其他 | O(N) | O(1) |
| warp | O(W·H) | 源图 RGBA 一份 + 输出一份 |
| original | O(1) | 0 |

---

## 8. 平台桥接实现

### 8.1 Android

`modules/image-core/android/.../ImageCoreModule.kt`

1. `System.loadLibrary("image_core")`；
2. Expo `AsyncFunction("processFile")` 接收
   `(inputPath, outputPath, filter: String, quality: Int)`；
3. `BitmapFactory.decodeFile`，`inPreferredConfig = ARGB_8888`、`inMutable = true`；
4. `bitmap.getPixels(IntArray)` → JNI `nativeProcessPixels`；
5. JNI 用 `GetIntArrayElements` 取裸指针，调用 `process_pixels`，
   `ReleaseIntArrayElements(..., 0)` 写回；
6. `bitmap.setPixels` + `compress(JPEG, quality)` 写文件；
7. `finally` 里 `bitmap.recycle()`。

计时用 `SystemClock.elapsedRealtime()`，分 decode / process / encode 三段，
`totalMs` 从函数入口算起。

几何变换是同一套流程的变体：

- `warpFile(input, output, quad: List<Double>, quality, maxDim)`：先
  `nativeWarpSize` 拿输出尺寸，再 `nativeWarp` 逐像素反查；`quad` 长度必须为 8。
- `resizeFile(input, output, maxDim, quality)`：`nativeResizeSize` → `nativeResize`。
- `rotateFile(input, output, degrees, quality)`：角度规整到 90/180/270，
  90/270 由 JNI 侧交换宽高后调 `nativeRotate`。
- 三者都不经过 base64：输入输出都是文件，复制/删除由 JS 负责。

JNI 错误码：`-1` 参数非法、`-2` 数组长度不足、`-3` 取指针失败
（几何函数里 `-3` 是 `quad` 长度不足）；Kotlin 侧 `check(result == 0)` 抛异常给 JS。
只读的源像素用 `ReleaseIntArrayElements(..., JNI_ABORT)` 释放，省掉一次写回拷贝。

CMake 以 `-O3`、`-fvisibility=hidden`、`--gc-sections` 编译共享库；
ABI 由 `reactNativeArchitectures` 决定（默认四个）。

### 8.2 iOS

`modules/image-core/ios/ImageCoreModule.swift` + `ImageCoreBridge.mm`

1. `UIImage(contentsOfFile:)?.cgImage` 解码；
2. 创建 `CGContext`，`bitmapInfo = premultipliedFirst | byteOrder32Little`，
   `bytesPerRow = width * 4`；
3. `context.draw(cgImage, ...)` 把图绘进 `[UInt32]` 缓冲区；
4. 调用纯 C 的 `ImageCoreProcessPixels`（Objective-C++ 文件里 `#include` 共享内核）；
5. `context.makeImage()` → `UIImage.jpegData(compressionQuality: quality/100)`；
6. `Data.write(to:options:.atomic)`。

`decodeMs` 在 `context.draw(...)` **之后**取值，把「加载 + 真正转成 ARGB 位图」
都算进解码，与 Android 的 `decodeFile` 口径一致；adjust 全为 0 时走
`ImageCoreProcessPixels`（与 Android 的 `nativeProcessPixels` 分支相同），
否则走 `ImageCoreProcessPixelsEx`。

几何变换共用 `decodePixels()` / `writeJpeg()` 两个私有方法（缓冲区格式与
`processFile` 完全一致），C 桥在 `ImageCoreBridge.h` 里导出
`ImageCoreWarpSize` / `ImageCoreWarp` / `ImageCoreResizeSize` /
`ImageCoreResize` / `ImageCoreRotate`；`.mm` 里把 `double quad[8]` 转成
`float[8]` 后转调共享内核。上桥的坐标是归一化的，和 Android 完全相同。

`createPdf` 与 Android 的 `decodeForPdf` 对齐：先按
`max(pageWidth, pageHeight) * 2` 计算像素上限，用 ImageIO 的
`CGImageSourceCreateThumbnailAtIndex`（带 `kCGImageSourceCreateThumbnailWithTransform`，
顺带应用 EXIF 方向）**逐页**降采样解码，一页画完就释放；早期版本用
`UIImage(contentsOfFile:)` 一次把全部页面解成全尺寸位图，30 页 12 MP 会直接
把内存打满。页面尺寸用 `CGImage` 的像素宽高，而不是 `UIImage.size` 的点。

`ImageCore.podspec` 把 `../common/*.{h,hpp,cpp}` 一起编进 pod，`static_framework = true`。
本机是 Windows，iOS 侧只能由 `.github/workflows/ios-unsigned-ipa.yml`
（macos-26，Swift tools 6.2）编译验证。

### 8.3 HarmonyOS

**NAPI 注册**：`napi_init.cpp` 与 Android 的 JNI 一一对应，导出 8 个函数：

| 函数 | 说明 |
|---|---|
| `version(): string` | `image-core/0.3.0` |
| `processPixels(buf, w, h, filter): number` | 滤镜原地处理 |
| `processPixelsEx(buf, w, h, filter, contrast, brightness, detail): number` | 滤镜 + 微调（-50..50 / 0..100） |
| `warpSize(srcW, srcH, quad, maxDim): number[]` | 透视裁剪输出尺寸 `[w,h]` |
| `warpPixels(src, srcW, srcH, dst, dstW, dstH, quad): number` | 透视裁剪 |
| `resizeSize(srcW, srcH, maxDim): number[]` | 等比缩放输出尺寸 |
| `resizePixels(src, srcW, srcH, dst, dstW, dstH): number` | 箱式平均/双线性缩放 |
| `rotatePixels(src, srcW, srcH, dst, degrees): number` | 顺时针 90/180/270 |

- 所有 buffer 参数必须是 `ArrayBuffer`，长度不足抛 `RangeError`；
  `quad` 既接受 `Float64Array` 也接受普通 `number[8]`；
- 参数个数、类型、宽高、角度都在 NAPI 层校验，错误码与 JNI 相同
  （`-1` 参数非法、`-2` 长度不足、`-3` 取指针失败）；
- 模块名 `image_core`，对应 `import imageCore from 'libimage_core.so'`。

**解码/编码**：`ImageCoreService.ets` 用 `image.createImageSource(fd)` 解码，
请求 `BGRA_8888`；`readPixelsToBuffer` 得到 `ArrayBuffer`；NAPI 原位修改；
`writeBufferToPixels`；`ImagePacker.packing(pixelMap, {format:'image/jpeg',
quality})`；最后写文件。所有句柄在 `finally` 里 `release/close`。`maxDim > 0`
时先读源尺寸，用 `desiredSize` 在**解码阶段**降采样，避免 12 MP 全展开。

**UI 与桥**：`Index.ets` 用 `<Web src=$rawfile('index.html')>`，通过
`javaScriptProxy` 注入 `dispatch` / `version`；页面加载完用 `runJavaScript`
调 `window.__onNativeReady()`。协议是单向请求 + 回推：

```
H5                                  ArkTS (NativeBridge)
 │ nativeBridge.dispatch(JSON)  ───►│ 串行队列
 │   {id, op, input, ...}           │  op 分发到 ImageCoreService / PdfSave
 │                                  │  解码 → C++ → 编码 → 文件
 │◄── window.__onNativeResult({...})│  data URL 只在需要显示时回传
```

op 一览：`sample`（把 rawfile 示例写进缓存并导入）、`pick`（系统相册多选）、
`base`（取旋转后的底图）、`render`（滤镜 + 微调）、`thumbs`（260 px 基准图
一次生成 11 个算法缩略图）、`warp`（透视裁剪）、`read`（只读文件成 data URL）、
`delete`、`pdf`、`saveImages`、`version`。

**H5 编辑器**：`rawfile/index.html` 是 RN `ScanEditorScreen` 的逐项对照实现：
顶部返回 / 文档名 / 分享，舞台 + 页码 + 按住看原图，11 个算法缩略图条，
对比度/亮度/细节滑杆，继续导入 / 左转 / 右转 / 裁剪 / 提取文字，保存所有图片 /
保存成 PDF；裁剪层同样是四角圆点 + 四边中点长条、64 px 就近抓取、非凸变红、
100 px / 2.6× / 88 px 偏移的放大镜。

**为什么不用 Promise 跨 Proxy 返回**：`javaScriptProxy` 的方法返回值经过
ArkWeb 的序列化，Promise 不可靠；统一走 `runJavaScript` 回推，错误也能作为
`{ok:false, error}` 返回。

**为什么用 data URL 显示**：ArkWeb 对沙盒 `file://` 的访问取决于
`fileAccess` 与来源，不能保证可读；算法处理始终用文件路径，只有当前页的
预览/缩略图读成 data URL。

**PDF**：`PdfWriter.ets` 解析 JPEG 的 SOF 取宽高，把原始 JPEG 字节以
`/DCTDecode` 嵌进 PDF（不重编码）；`PdfSave.ets` 统一「先写缓存 → 系统保存框
→ 拷贝 → 清理」，`PdfPage.ets` 与 H5 桥共用这一份逻辑。

### 8.4 桌面端（Windows / macOS / Linux）

桌面不需要 RN，直接在 `common/` 外面加一层稳定的 **C ABI**：

```c
const char* ic_version(void);
int32_t ic_process_argb32(uint32_t*, int32_t w, int32_t h, int32_t filter);
int32_t ic_process_rgba(uint8_t*, int32_t w, int32_t h, int32_t filter);
```

- `ic_process_argb32` 就是 §6.1 的内存布局，和 Android/iOS/鸿蒙完全一致。
- `ic_process_rgba` 接收行优先 `R,G,B,A` 字节，内部交换 R/B 后复用同一个内核，
  因此 Python `bytearray`、Java `byte[]`、Qt `QImage::Format_RGBA8888` 都能零拷贝
  传入。`original` 直接在入口短路返回，不碰缓冲区。
- 返回码：`IC_OK(0)` / `IC_ERR_ARGUMENT(-1)` / `IC_ERR_FILTER(-2)`；不抛异常、
  不分配内存、无全局状态，可并发调用。
- 构建产物：`image_core.dll|dylib|so`（C ABI + JNI 编进同一个库）和命令行
  `imagecore`（stb 解码 + 同样的 C ABI + 按扩展名编码）。JNI 只编入不链接
  `libjvm`，所以 Python `ctypes.CDLL` 加载时不需要 JVM。
- 详见 [modules/image-core/desktop/README.md](../modules/image-core/desktop/README.md)。

桌面界面用 Electron（`desktop/electron/`）而不是 RN：主进程 `spawn` 上面那个
命令行，渲染进程 `contextIsolation + sandbox`，只经 `preload.js` 暴露几个 IPC，
不引入任何原生 Node 模块。这样 UI 的崩溃面与算法隔离，换 UI 框架也不用动算法。
打包（`npm run package`）把 `imagecore` 和动态库放进 `resources/`，目标机器
不需要 Node、不需要 C++ 运行库。

CI 在 `ubuntu-latest` / `macos-latest` / `windows-latest` 上跑 C++ 自检、CLI
四滤镜、Python ctypes 与 Java JNI 四组用例，外加 Electron 三个脚本的语法检查
（`.github/workflows/desktop-image-core.yml`）。

---

## 9. WebView Canvas 回退

### 9.1 为什么需要

Hermes 没有 JIT。纯 JS 做 JPEG 解码 + 逐像素 + 编码，1 MP 图在 Android 9 模拟器上
需要 1–2 分钟；WebView 的 JS 引擎有 JIT，`getImageData` / `toDataURL` 是原生实现，
同样的图 200–500 ms。因此回退引擎选择 Canvas，而不是 JS 解码库。

### 9.2 结构

- `FilterEngineHost` 在 `App.tsx` 根部挂载一次，`position: absolute`、1×1、
  `opacity: 0.01`、`pointerEvents="none"`；
- HTML 是 `filterEngine.tsx` 内的模板字符串，包含完整的 Canvas 滤镜实现；
- 模块级单例：`ready` Promise、`pending` Map、`post` / `inject` 函数引用。

### 9.3 协议与时序

```
RN                                    WebView
 │  source={html}                        │
 │◄──────────── {type:"ready"} ──────────│  或 onLoadEnd 兜底
 │                                       │
 │── postMessage({id,op,b64,filter,      │
 │    contrast,brightness,detail}) ─────►│
 │   （1.5s 内没被处理则 injectJavaScript 再发一次）
 │                                       │ op='filter' → img.onload → 逐像素
 │                                       │ op='warp'   → 单应变换 + 双线性
 │                                       │ canvas.toDataURL(JPEG)
 │◄── {id,ok,dataUrl,ms,width,height} ───│
 │                                       │
 │  15s 启动超时 / 30s 单次超时           │
```

- `ready` 同时由页面 `postMessage` 和 WebView `onLoadEnd` 触发，谁先到算谁。
- `postMessage` 走 `window.postMessage` / `document.message` 双监听，兼容旧 WebView。
- `injectJavaScript` 作为兜底：`window.__applyFilterPayload(<json>)`。
- 超时后从 `pending` 删除并 reject，避免泄漏。
- 计时日志 `[image-core:canvas] <filter> <w>x<h> process=...ms total=...ms`。

### 9.4 与原生实现的差异

| 维度 | 原生 | Canvas |
|---|---|---|
| 亮度 | 整数 `(299R+587G+114B)/1000` | 浮点加权 |
| 输出取整 | `static_cast<int>` 截断 | `Uint8ClampedArray` 四舍五入 |
| 像素顺序 | BGRA 内存 / ARGB 整数 | RGBA |
| 编码 | 平台 JPEG（质量 92） | `toDataURL('image/jpeg', 0.9)` |
| 数据通道 | 文件，不经过 base64 | base64 字符串进出 |
| alpha | 原样保留（iOS 预乘） | 原样保留 |
| 微调 | `process_pixels_ex`（整数） | 同一公式的浮点实现 |
| 四角裁剪 | C++ `warp_pixels`（默认） | Expo Go 兜底（同一套单应矩阵公式） |

量化差异见 §13.2。

---

## 10. UI 与状态管理

### 10.1 路由

`App.tsx` 用联合类型做状态机：

```ts
type Route =
  | { name: 'home' }
  | { name: 'camera' }
  | { name: 'picker'; title: string; returnTo: 'home' | 'camera' }
  | { name: 'scanEditor'; draftId: string; sourceUris: string[]; title: string }
  | { name: 'doc'; doc: ScanDoc }
  | { name: 'pdf'; doc: PdfDoc }
  | { name: 'pdfReader'; doc: PdfDoc; initialPage?: number }
  | { name: 'pageEditor'; doc: PdfDoc; pageId: string; backTo?: 'pdf' | 'pdfReader' };
```

`scanEditor` 用 `key={draftId}` 挂载：同一份草稿再次进入时状态不串；
相册选择器是独立路由（首页/相机入口）或编辑器的浮层（继续导入），两种用法
共享 `PhotoPickerScreen`。

没有 URL、没有深链、没有返回栈；各页面互斥渲染。优点是实现小、状态直观；
缺点是没有统一的返回栈，返回键由各页面自己注册 `BackHandler`（选择器先关预览
再退出，编辑器先弹「放弃本次导入？」）。迁移到 Expo Router 的路径见 §15.4。

### 10.2 编辑器状态

`EditorScreen`（PDF 单页）：

```ts
currentUri   // 已缩放的基础图
filter       // 当前选中的滤镜
processed    // { key, uri, source: 'native' | 'canvas' }
processing   // 遮罩
saving
error
reqId        // 竞态保护
```

`ScanEditorScreen`（导入编辑页）：

```ts
pages / pagesRef   // 多页状态，异步回调一律基于 ref 提交
active             // 当前页索引（activeRef 供手势回调使用）
docTitle           // 顶栏文档名（默认第一张图片文件名，可改）
busy               // import | apply | pdf | export | crop | replace
applyAll           // 「应用到所有页」
compare            // 按住对比 → 显示 originalUri（含旋转）
baseUri/baseCache  // 当前页 rotation 后的原图，裁剪/缩略图/预览共用
thumbs/thumbCache  // 每个算法一张图（原生文件 / Canvas data URI），
                   // 按 (id:rotation:source) 缓存并记录要清理的临时文件
adjustOpen/draftAdjust/previewUri  // 第二步微调与实时预览
cropMode/quad/     // 四角裁剪
loupe              // CropOverlay：整层 PanResponder + 就近抓取（64 dp），
                   // 触摸区比图片外扩 22 dp（贴边手柄才按得到）
                   // 拖动时页面在最外层画 100 dp / 2.6x 放大镜（CropLoupe），
                   // 镜心与手柄固定偏移 88 dp，不夹取 → 1:1 跟手不跳；
                   // 超出图片的部分透明，只有图片区域被放大
```

关键点：

- 所有算法 / 微调都从 `originalUri`（+ rotation）重算，不叠加压缩。
- 微调预览使用 900 px 中图，只有确认时才写全尺寸结果；`previewSeq` 防止
  连续拖动时旧结果覆盖新预览。
- 算法缩略图是 260 px 小图逐个进原生（无原生库时进 Canvas），页切换/旋转后
  按 key 复用；裁剪替换源图时清掉该页所有派生缓存和临时文件。
- `busy` 在事件处理器里立即置位（避免“点完没反应”），并禁用会改状态的操作。
- 出错时显示当前语言的错误文案，保存失败不会卡在“保存中”。

### 10.3 页面职责

| 页面 | 职责 |
|---|---|
| Home | 扫描三入口、图片转 PDF 入口、PDF 列表、文档列表、长按/按钮删除、空状态 |
| Camera | 权限申请、取景框、快门、相册入口 |
| PhotoPicker | 应用内相册：分页网格、点选 + 横向划选、按选择顺序编号、全屏预览、完成回调；`limit` 由调用方给 |
| ScanEditor | 导入编辑页：批量/继续导入、滑动翻页、页码行按住对比、算法缩略图、第二步微调、应用到所有页、四角裁剪、旋转、删除/重拍此页、可编辑的 PDF 文档名、分享、全部页面保存到相册、保存成 PDF |
| OcrScreen | 文字识别：导入/拍照 → 逐页识别（端侧优先，服务端兜底）→ 每页一个文本框编辑；点框或移动光标把图片放大到那一行；复制 / 分享文本 |
| OcrBoxOverlay | 识别框只负责显示（`pointerEvents="none"`），命中判断在 OcrScreen 的图片层统一做 |
| CropOverlay | 四角裁剪的手势层：角点圆圈、边中点长条；整层就近抓取（GRAB_RADIUS），触摸区外扩 `inset` 让贴边手柄可抓；非凸四边形边框变红 |
| CropLoupe | 拖动时的放大镜：透明圆形视窗，镜心与手柄固定偏移、不夹取（1:1 跟手），只放大图片区域，界外透明 |
| Editor | 预处理、滤镜切换、旋转、保存；`showPageTools` 时额外显示切边/批注/恢复原图 |
| Document | 逐页查看（缩略图条）、一次导出全部页、删除确认 |
| Pdf | 选默认算法、多选添加（自动执行算法）、批量应用、「原图」重置、排序、移除、单页编辑入口、生成/重新生成/分享、进度与取消 |

路由扩展（`App.tsx` 的 `Route`）：

```ts
| { name: 'pdf'; doc: PdfDoc }
| { name: 'pageEditor'; doc: PdfDoc; pageId: string }
```

`PdfScreen` 内部持有 `pages / pdfUri / generatedAt / updatedAt / defaultFilter /
limits / busy`，每次改动都通过 `onUpdate` 回写 `App.tsx` 并落盘；`PdfScreen` 用
`key={doc.id}` 挂载，切换项目时状态不会串。单页编辑返回时 `App.tsx` 会把最新
`PdfDoc` 作为新的 `route.doc`，避免拿到打开时的快照。

新建 PDF 时先创建空草稿并直接进入 `PdfScreen`（不再在首页弹相册选择器），
这样用户可以先选算法再导入；空草稿只在第一次导入成功后才由 `onUpdate` 写入索引。

### 10.4 多语言（i18n）

目标：不引入第三方 i18n 依赖，一套代码同时发国内版与海外版。

- **词典**：`src/lib/i18n.ts` 里的英文词典用 `as const` 定义，`keyof` 即
  `MessageKey`；简体中文位于同文件，其余 7 种语言位于 `src/lib/locales/`，
  全部声明为 `Record<MessageKey, string>`，少翻/多翻都会在 `tsc --noEmit`
  阶段报错。当前支持 `en / zh / zh-Hant / ja / ko / fr / de / es / pt`。
- **复数**：按 `key_one` / `key_other` 两套键，`tp(key, count)` 默认在
  `count === 1` 时用单数；法语按 CLDR 把 0 也视为单数。中文、日文、韩文
  两套键写同样文本（没有单复数变化）。
  `PluralKey` 由 `MessageKey` 模板字面量推导，调用处不会拼错后缀。
- **运行时**：模块级 `currentLocale` + `version` 计数器。
  `useI18n()` 通过 `useSyncExternalStore` 订阅变化，切换语言后所有使用它的
  组件立即重渲染；非组件代码（存储、PDF、滤镜错误）直接用 `t()`。
  `t` / `tp` 是模块级函数而不是闭包，`useCallback` 不会捕获旧语言。
- **持久化**：偏好存 `AsyncStorage` 的 `settings.locale.v1`，取值为
  `system` 或 9 个语言标签之一；`App.tsx` 启动时先 `await initI18n()` 再加载
  文档，保证旧数据里缺标题的记录按当前语言生成默认名。
- **跟随系统**：`expo-localization` 的 `getLocales()[0]`：`languageCode` 为
  `zh` 时再看 `languageScriptCode`（`Hant`）和地区（TW/HK/MO）区分简繁；
  `ja/ko/fr/de/es/pt` 直接映射到对应词典；其余一律回退 `en`。设置页提供
  「跟随系统 + 9 种语言」共 10 个选项，语言名称始终用该语言自身的写法。
- **系统级文案**：`app.json` 的 `locales` 指向 `locales/<tag>.json`（9 个），
  prebuild 时分别生成 iOS 的 `InfoPlist.strings`（`CFBundleDisplayName`、
  相机/相册权限说明）和 Android 的 `values-b+<tag>/strings.xml`（`app_name`）。
  基础 `app.json` 用英文，英文是缺省回退。`expo-localization` 的
  `supportedLocales` 同步声明这 9 个 BCP-47 标签，让系统设置里的
  「App 语言」列表与内置词典一致。
- **算法名**：`FILTER_LABEL_KEYS` / `ADJUST_LABEL_KEYS` 把稳定的算法 key 映射到
  词典键，`filterLabel()` / `adjustLabel()` 在渲染时取词，不再有模块级
  `FILTER_LABELS` 常量，因此算法名会跟随语言切换。

取舍：当前 9 种语言的复数规则都只需区分单复数（法语额外把 0 当单数），
所以没有引入 `Intl.PluralRules`；若以后加入俄语、阿拉伯语、波兰语等复杂
复数语言，应改用 `Intl.PluralRules` 并把词典拆成
`_zero/_one/_two/_few/_many/_other`。阿拉伯语、希伯来语等 RTL 语言同理
需要在 `expo-localization` 插件里打开 `supportsRTL` 并检查布局。

---

## 11. 存储与数据模型

```ts
type ScanDoc = {
  id: string;          // Date.now() 字符串，同时是草稿/文档目录名
  title: string;       // “导入图片 10-24 0852”
  pages: DocPage[];    // 至少 1 页
  createdAt: number;
  updatedAt: number;
};

// 扫描与 PDF 共用的页面结构（types.ts）
type DocPage = {
  id: string;
  originalUri: string;  // 导入时写入，永不覆盖
  uri: string;          // 当前显示/导出的版本
  thumbUri: string;     // 220px 缩略图
  filter: FilterKey;                  // 11 种算法之一（src/lib/filters.ts）
  rotation: 0 | 90 | 180 | 270;
  adjust?: PageAdjust | null;         // 第二步：contrast/brightness -50..50, detail 0..100
  cropQuad?: DocumentQuad | null;     // 预留（手动裁剪会烘焙进 originalUri）
  annotations?: PageAnnotation[];     // 预留
};
```

`adjust` 与 `cropQuad` 都是可选字段：旧索引没有它们时，
`sanitizePage` 把 `adjust` 归零、`cropQuad` 置 null。
`PageEdit`（保存参数）同样新增 `adjust`，`savePageEdit` 用
`editNeedsRender()` 判断是否需要重新编码。
裁剪会替换 `originalUri` 并把 `rotation` 归零；这是唯一会删除旧原图的路径。

| 数据 | 位置 |
|---|---|
| 页面文件 | `documentDirectory/scans/<id>/{src,thumb,edited}/<pageId>[_<ts>].jpg` |
| 旧版单图 | `documentDirectory/scans/<id>.jpg`（仅读，迁移后不再写入） |
| 索引 | AsyncStorage，key `scans.index.v1`，JSON 数组 |

- `loadDocs` 解析失败返回空数组，不让坏索引阻塞启动；每条记录经 `sanitizeDoc`
  校验，`pages` 为空则丢弃。
- **旧记录迁移**：v1 的 `{ uri, thumbUri, filter }` 在读取时就地变成 1 页
  `{ originalUri: uri, uri, thumbUri, filter, rotation: 0 }`，原文件路径不变；
  删除时按 `originalUri` / `uri` / `thumbUri` 去重删除，旧版 `<id>.jpg` 也会被清掉。
- 草稿目录与正式文档同构：编辑器导入的半成品就在 `scans/<draftId>/` 下，
  只有点「保存」才写索引；取消直接删目录，不需要逐个文件回滚。
- 索引先写列表再落盘；`saveIndex` 失败仍可能留下孤儿目录（见 §17）。

### 11.1 PDF 数据模型

```ts
type PdfDoc = {
  id: string;
  title: string;
  pages: DocPage[];          // 与 ScanDoc.pages 同一结构
  uri: string | null;        // 生成的 PDF；未生成时为 null
  pageCount: number;
  createdAt: number;
  updatedAt: number;         // 任何页面变化
  generatedAt: number | null;
  defaultFilter: FilterKey;  // 新导入图片自动使用的算法
};

// DocPage 见 §11：originalUri 永不修改，uri 是当前参与生成的图，
// thumbUri 是 220px 列表缩略图
```

目录布局（每个 PDF 一个自包含目录）：

```
documentDirectory/pdfs/<pdfId>/
  document.pdf          # 生成结果（原子替换）
  src/<pageId>.jpg      # 导入时缩放后的源图（originalUri）
  thumb/<pageId>.jpg    # 220px 缩略图
  edited/<pageId>.jpg      # 导入时自动算法的结果
  edited/<pageId>_<ts>.jpg # 单页编辑 / 批量应用的结果
```

- 索引：AsyncStorage key `pdfs.index.v1`；`loadPdfs` 对每条记录做字段校验
  （`sanitizeDoc` / `sanitizePage`），坏数据丢弃而不是让首页崩溃；
  旧记录没有 `defaultFilter` 时按 `'original'` 补全。
- 缩略图单独落盘：首屏只解码 220px 小图，不把 1500–1800px 的源图交给 FlatList。
- 删除项目直接删整个 `pdfs/<id>/`，不需要逐个文件追踪。
- `edited/` 下的旧文件在保存新编辑时删除；`originalUri` 与 `thumbUri` 永不误删。

---

## 12. 错误处理与降级

### 12.1 降级链

```
原生模块可用？
  ├─ 是 → processFile / warpFile / resizeFile / rotateFile（文件路径）
  └─ 否 → WebView Canvas（base64 data URL）
           └─ 引擎 15s 未就绪 / 单次 25s 超时 → 报错“滤镜处理失败”
```

几何变换按能力探测：`isNativeGeometryAvailable()` 检查三个 `*File` 方法是否
都存在。旧原生库（0.2.x）只有滤镜时，`resizeImage` / `rotateImage` 退回
`expo-image-manipulator`，裁剪退回 Canvas，不会因为方法缺失直接报错。

`ImageCoreModule.ts` 在模块加载时 `try { requireNativeModule('ImageCore') }`，
失败只记录 `loadError`，不抛给调用方；`isImageCoreAvailable()` 决定走哪条路。

### 12.2 错误文案

| 场景 | 行为 |
|---|---|
| 图片读取失败 | 编辑器底部红字“图片读取失败” |
| 滤镜失败 | “滤镜处理失败：<message>” |
| 旋转失败 | “旋转失败” |
| 保存失败 | “保存失败”，恢复保存按钮 |
| 相机不可用 | Alert：建议改用导入或示例 |
| 相册权限拒绝 | Alert：提示去系统设置 |
| 示例资源加载失败 | Alert：“加载示例失败” |
| 导出失败 | Alert：带原生错误信息 |

### 12.3 独立安装包里的示例图片

Expo Go 里 `Asset.fromModule(...).localUri` 是缓存文件路径；但在独立 APK 里，
Metro 打包的图片被 aapt 编成 drawable 资源，`resolveAssetSource` 返回的是资源名
（例如 `3c`）或 `file:///android_res/...`。expo-asset 会把“无冒号的 URI”当成已下载，
直接返回资源名——`Image.getSize` 和 ImageManipulator 都无法读取。

`resolveBundledAsset` 的处理：

1. 只有 `file://` 且不是 `file:///android_res/` 才直接返回；
2. 否则清空 `localUri` / `downloaded`，强制 `downloadAsync()`；
3. expo-asset 原生分支识别资源名与 `android_res` URI，把内容复制到
   `cacheDirectory/ExponentAsset-<hash>.<ext>`；
4. 返回真实文件路径；失败时 `console.warn` 并回退到原 URI。

这一步只在独立包里有意义，但 Expo Go 走第 1 条分支，无副作用。

---

## 13. 性能与验证结果

### 13.1 宿主侧循环耗时

同一份 600×800 RGBA 像素，C++ 内核（Node-API 插件）与 Canvas（headless Edge）：

| 滤镜 | C++ process | Canvas 循环 |
|---|---|---|
| gray | 1.77 ms | 3.2 ms |
| bw | 1.88 ms | 5.0 ms |
| enhance | 3.63 ms | 5.8 ms |

单滤镜端到端（含解码/编码）在宿主 WebView 里约 10 ms（1200×1600）。

### 13.2 原生 vs Canvas 像素差异（600×800，同一输入）

| 滤镜 | 完全一致 | ±1 以内 | 最大差 | 平均差 |
|---|---|---|---|---|
| gray | 4.376% | 69.633% | 2 | 1.26 |
| bw | 99.995% | — | 255 | — |
| enhance | 3.182% | 99.779% | 24 | 0.797 |

- gray：整数亮度 + 截断 vs 浮点 + 四舍五入，几乎全部落在 ±1；少量像素跨过
  `clamp` 边界后差 2。
- bw：Otsu 阈值在整数/浮点亮度下可能差 1，导致阈值附近 25 个像素翻转
  （480,000 像素中的 0.005%）。
- enhance：`lum > 165` 分支边界两侧输出不连续，临界像素最大差 24；
  其余 99.78% 在 ±1 内。
- alpha：0 个不一致。

### 13.3 Android 模拟器端到端（1050×1400）

Release APK（原生模块，Android 9 / `emulator-5554`）：

| 滤镜 | decode | process | encode | total |
|---|---|---|---|---|
| enhance | 139 ms | 120 ms | 53 ms | 379 ms |
| gray | 37 ms | 3 ms | 49 ms | 93 ms |
| bw | 17 ms | 16 ms | 44 ms | 86 ms |

Expo Go（Canvas 回退，同尺寸）：

| 滤镜 | total |
|---|---|
| gray | 252–338 ms |
| bw | 423–474 ms |
| enhance | 350–387 ms（冷启动 1177 ms） |

结论：灰度/黑白从数百毫秒降到约 90 ms；增强两端在模拟器上接近（350–387 ms
vs 379 ms），因为 Canvas 的 JIT 对这段逐像素浮点循环同样很快，而原生路径多了
`getPixels`/`setPixels` 的内存拷贝。模拟器数据只用于相对比较，不代表真机绝对值。

### 13.3.1 PDF 生成（Android 9 模拟器）

同一批 1200×1600 测试图，在 **debug 构建**（含原生 ImageCore）上实测：

| 场景 | PDF 大小 | 实际页数 | 说明 |
|---|---|---|---|
| 1 页 | 127,896 B | 1 | A4，`/MediaBox [0 0 594.96 840.96]` |
| 加 2 页后重新生成 | 128,858 B | 3 | 三张源图字节相同，打印器复用同一个 image XObject |
| 第 1 页改灰度后重新生成 | 272,014 B | 3 | 2 个 image XObject（灰度页 + 原图页） |

- `expo-print` 返回的 `numberOfPages` 在这几次调用里都是 **1**，但解析 PDF 得到
  的 `/Count` 与 `/Kids` 都是 3——该字段是按 WebView 内容高度估算的，不可信，
  代码不再据此告警。
- 单页编辑保存后生成独立 `edited/<pageId>_<ts>.jpg`，`originalUri` 未变。
- 分享：`expo-sharing` 正常拉起系统分享面板（Bluetooth / Gmail / Save to Drive）。
- 「保存成 PDF」（扫描编辑器）在 Android 9 模拟器上走 SAF：选 Downloads →
  `/sdcard/Download/导入图片.pdf`，262,060 B，首字节 `%PDF-1.4`；顶栏改名后
  再保存得到 `/sdcard/Download/Test_Doc.pdf`，993,847 B，`/Count 1`。
  写入必须用新 API（`Directory.createFile` / `File.copy`）：旧 API 的
  `writeAsStringAsync` 会用 `DocumentFile.canWrite()` 校验目标目录，而 Downloads
  这类系统 provider 恒返回 false，会误报 `Location ... isn't writable`。
- 顶栏「分享」：生成后 `Sharing.shareAsync` 拉起系统 `CHOOSER`（logcat 可见
  `act=android.intent.action.CHOOSER`），不再复用底部「保存成 PDF」。
- 底部「保存所有图片」：模拟器相册 `MediaStore` 新增
  `p_<pageId>_<ts>.jpg`，提示「N 页已保存到系统相册。」
- 裁剪手势：模拟器上从距角点约 18 dp 处按下也能抓住（就近抓取），拖动中
  放大镜跟随手柄；边中点同样以长条中心放大。`重置` 回到整图四角。
- 贴边手柄：默认整图四角时，四个角点和四条边中点全压在图片边界上。
  触摸区域若与图片等大，`adb shell input swipe` 在这些点上完全收不到事件
  （Android 只把触摸派发给命中自身边界的视图），表现为「拖不动」。
  现在裁剪框容器向外扩 `CROP_GRAB_PAD`（22 dp），图片按像素尺寸内缩摆放，
  `CropOverlay` 用 `inset` 偏移绘制与命中判定。修复后从边界正中按下即可拖动。
- 放大镜透明区域：把左上角沿竖直方向拖动，镜心停在图片左边界上，
  截图取样 x=20/60（镜内、图片外）为背景色 `#0b0d12`，x=130 起为放大后的纸面白，
  确认镜外区域是透视的。
- 非凸四边形：把右上角拖到左下方向后，四条边框变红、底部提示
  「无效区域：四个点要围成凸四边形，边不能交叉或凹陷」，「确定」置灰。
- Expo Go（无原生模块）走 base64 兜底：日志先出现
  `cannot copy print output ... retrying with base64`，随后 `[pdf] done`，
  说明沙盒限制已被兜底吸收。
- debug 构建的滤镜耗时（gray 1200×1600：decode 27 / process 205 / encode 144 /
  total 509 ms）明显高于 release，不要拿它和 §13.3 的 release 数据比较。

### 13.3.2 内存设计的实测约束

- 导入阶段一次只处理一张图，`persistPdfPages` 的峰值与总页数无关；
- 生成阶段的峰值 = 整份 HTML（含全部 base64）+ WebView 排版。实测 3 页
  1200×1600 JPEG（每张约 127 KB）对应的 PDF 约 128–272 KB，HTML 里每页
  base64 约 170 KB，属于安全区间；
- 页数上限按内存分档（`pdfLimits.ts`）：物理内存 15–60 页，并用 Android
  JVM 堆进一步收紧。以 4 GB / 256 MB 堆设备为例，上限 25 页；25 页 × 1200 px
  × 0.82 时 HTML 约 5–10 MB，加上 WebView 位图仍在余量内。
- 上限是**估算**：expo-print 的真实峰值还取决于 WebView 是否同时解码全部图片。
  低端机优先保证不 OOM，宁可比理论值少几页；要完全消除这层不确定性，
  只能切换到原生流式写入（鸿蒙端已在 `PdfWriter.ets` 实现，见
  [EDGE_DETECTION.md](EDGE_DETECTION.md) §6）。

### 13.3.3 导入编辑器（Android 9 模拟器，2026-10-24）

debug 构建 + 原生 ImageCore，一次导入 3 张 646×1400 截图：

| 操作 | 实现 | 实测 |
|---|---|---|
| 导入自动增强 ×3 | 原生 `processFile` | 214 / 301 / 380 ms |
| 算法缩略图 ×11 | 原生 `processFile`，输入 113×260 | 每张 3–57 ms，单页约 0.2 s 出齐 |
| 第二步微调预览 | 原生 `processFileEx` 415×900 | 102 ms |
| 微调保存（3 页） | 原生 `processFileEx` | 38–159 ms/页，全部约 0.3 s |
| 应用到所有页 ×3 | 原生 `processFile` | 83 / 115 / 374 ms |
| 裁剪透视校正 | 原生 `warp_pixels`（C++）1050×1400 → 1050×1400 | decode 21 / process 120 / encode 114 / total **284 ms** |
| 旋转（右转 90°） | 原生 `rotate_pixels`（C++）1050×1400 → 1400×1050 | decode 8 / process 12 / encode 68 / total **118 ms** |
| 保存到相册 | `MediaLibrary.saveToLibraryAsync` | 立即，弹出「已保存」 |
| 生成 PDF（3 页） | 原生 `PdfDocument`（Android） | 784–926 ms，794 KB，`/Count 3` |

- 裁剪是唯一破坏性操作：`warp_pixels` 直接写出新的源图文件（不再经过
  base64），`copyAsync` 落进 `src/` 后按原算法和微调重新渲染；透视校正会改变
  长宽比，`cropQuad` 因此清空。
- 算法缩略图与微调预览在有原生库时全部走 native：缩略图输入是当前页缩到
  260 px 的临时 JPEG，输出也是文件（不再拼 base64 data URI），因此缓存结构从
  `Record<key, uri>` 变成 `{ uris, files }`，切页/裁剪/卸载时按 `files` 删除。
- 只有 Expo Go（无原生库）才回退到「小图 base64 → WebView Canvas」，
  缩略图每张 0.2–0.8 s、微调预览约 0.7 s，是性能兜底路径。
- 缩略图、微调预览、裁剪在 Expo Go 里共用同一个 WebView canvas，全部走串行
  队列，实测没有互相覆盖（日志里各任务的时间戳严格递增）。
- warp 进 C++ 前是这条链上最慢的一步：同一张 646×1400 的图，Canvas 逐像素
  双线性要 **5.6 s**，而 C++ `warp_pixels` 在 1050×1400 上只要 **284 ms**
  （process 120 ms），其中大头是和 Canvas 版相同的解码/编码。Expo Go 里仍然
  是 Canvas 路径（约 5.6 s），所以裁剪的耗时差异只在装了原生库的构建里消失。
- 裁剪舞台四周留 26 dp（`CROP_INSET`）：手柄半径 22 dp，贴边时若不留白，
  上/下手柄有一半落在舞台外，按不到。
- 裁剪框的触摸容器再向图片外扩 22 dp（`CROP_GRAB_PAD = CROP_INSET - 4`）：
  仅留白还不够——触摸区域必须真的比图片大，否则贴边手柄的外半截
  连事件都收不到（见 §11 验证记录）。扩出的部分仍在舞台留白以内。

#### PDF 分页修正

初版 CSS 的 `.page` 只有 `page-break-after`，图片 `max-height` 又正好等于 A4
高度；Android WebView 的亚像素取整把每个 section 撑到第二页，3 张图生成出
**6 页** PDF，而 `numberOfPages` 始终报 4，从日志里看不出问题。改成固定
595×842 的 `.page`（flex 居中 + `overflow: hidden` + 图片 `max-width/height:
100%`）后，解析 PDF 得到 `/Type /Page` × 3，与请求页数一致。

#### 原生 PDF 写入

`expo-print` 的路径是「整份 HTML（含所有页的 base64）→ WebView 排版 → 打印」，
3 页实测要 60–100 s，期间 JS 线程被占满，界面看起来像卡死。现在 ImageCore 增加
`createPdf(inputPaths, outputPath, pageWidth, pageHeight)`：

- Android：`android.graphics.pdf.PdfDocument`，逐页 `decodeFile`
  （`inSampleSize` 把长边压到约 2× 页面尺寸）→ `drawBitmap` 居中铺满 → `writeTo`；
- iOS：`UIGraphicsPDFRenderer` + `UIImage.draw(in:)`；
- TS：`src/lib/pdf.ts` 优先调用它，失败（旧原生库 / Expo Go）才回落到 expo-print；
- 页数直接由图片张数决定，不再有「3 张图 6 页」和 `numberOfPages` 虚报的问题。

生成完成后先 `end()` 结束忙碌态，再弹系统保存框（Android：SAF 文件夹选择器；
iOS：分享面板）。模拟器上系统面板本身要 3–5 s，之前这段时间仍显示「正在生成 PDF」，
会被误认为卡住。

「保存成 PDF」以前直接拉分享面板，用户看到的是 Bluetooth / Gmail / Save to Drive，
不像「保存」；现在 Android 先让用户选文件夹（`src/lib/savePdf.ts`），保存成功后再
提供「分享」按钮。写入用新 API 的 `File.copy`（原生流式拷贝），不经过 JS base64。

#### 页码与「应用到所有页」

- 页码行改成「左侧 flex 占位 + 中间 ◀ 页码 ▶ + 右侧 flex 占位」，中间那组
  相对整行居中；上下移动页面的 ↑/↓ 已去掉。对比从图片浮层移到这一行右侧，
  做成「分割图标 + 原图 | 对比」的胶囊按钮，按住显示原图、松开回到处理后。
- 删除从工具栏移到图片右上角（✕）。点击弹三选一确认框：删除此页 /
  重拍此页 / 取消；重拍会打开 `limit = 1` 的同一相册选择器，选中后原地替换
  该页源图（`replacePageSource`），再按该页原算法/微调重渲染，页序不变。
- 「应用到所有页」默认勾选。它之前「勾了不生效」的原因是事件回调闭包捕获了
  旧 state：生成缩略图占用 JS 线程时，勾选后的重渲染还没提交，紧接着点算法
  读到的仍是 `false`。现在用 `applyAllRef`（effect 同步）在
  `handleFilterPress` / `confirmAdjust` 里读最新值。

### 13.4 测试矩阵

| 项目 | 方式 | 结果 |
|---|---|---|
| WebView 引擎 | headless Edge 执行真实 HTML，11 项引擎 + 52 项 H5 编辑器 | 63/63 |
| Android NAPI 桥 | `napi_init.cpp` 编为 Node 插件 | 10/10 + 12 MP 计时 |
| iOS 桥 | `ImageCoreBridge.mm` 在宿主用 g++ 编译（纯 C++） | 35/35（滤镜/微调/几何/参数校验） |
| 跨端契约 | filter id、像素布局、字段、模块名 | 44/44 |
| Android 应用 | 模拟器安装 release APK，示例文档→三种滤镜→保存→首页记录 | 通过（相机/相册导出未在模拟器验证） |
| 图片转 PDF | 模拟器 debug APK：多选导入→排序→生成→单页灰度→重新生成→分享 | 通过（1/3 页 PDF 均为 A4，页数正确） |
| Expo Go PDF | 无原生模块，base64 兜底 | 通过（自动重试并写盘） |
| 自动算法 / 批量应用 | 模拟器 debug APK：导入 2 张 → 单页改黑白 → 批量改回增强 → 重启 | 通过（导入即增强、单页覆盖生效、批量前有覆盖提示、重启后状态保留） |
| 页数自适应 | 模拟器 1.5 GB RAM / 384 MB 堆，看页脚与上限 | 通过（判定 15 页 / 1200 px；2 页 PDF 仍为 A4） |
| 多页扫描 / 应用内选择器 | 模拟器 debug APK：选 2 张（序号 1、2）→ 全屏预览翻页 → 完成 → 编辑器导入 2 页 → 继续导入 1 张 → 第 3 页灰度 → 上移 → 删除第 2 页 → 保存 → 详情导出 2 页 | 通过（序号/预览/续页正确，追加与排序/删除同步，首页显示「2 页」，导出提示「2 页已导出」） |
| 导入编辑器 | 模拟器 debug APK：导入 3 张 → 滑动/三角翻页 → 按住对比 → 11 个算法缩略图 → 去阴影 + 对比度 37 → 应用到所有页改黑白 → 裁剪（四角 + 四边，含透视）→ 继续导入 → 左转 | 通过 |
| 原生几何（warp / rotate） | 模拟器 debug APK：示例文档 → 裁剪拖左上角 → 确定（C++ warp，输出 1050×1400，页面被替换、无报错）→ 右转 / 左转（C++ rotate，90°+270° 往返回到原状） | 通过（`warp total=284 ms`、`rotate 90° total=118 ms`） |
| 编辑页顶栏 / 导出 | 模拟器 debug APK：标题默认取首图文件名（`s26`）→ 改成 `Test_Doc` → 分享（系统 CHOOSER）→ 保存所有图片（相册 +1）→ 保存成 PDF（SAF → `Download/Test_Doc.pdf`，`%PDF-1.4`）→ 返回（弹出放弃确认） | 通过 |
| 划选 / 重拍 | 模拟器 debug APK：相册里横向划选一行 → 完成 → 图像右上角 ✕ → 重拍此页 → 选 1 张 → 完成 | 通过（一格起手整行选中、右上角 ✕ 三选一确认、重拍后该页源图与缩略图更新，页码不变） |
| 鸿蒙 PDF | hvigor 编译 HAP + `PdfWriter.ets` 源码在宿主用 `fileIo` 桩运行 + `pdf-lib` 解析 | 13/13 字节校验（1/2 页）、独立解析 2 页 A4；未在真机/模拟器运行 |
| 鸿蒙扫描编辑器 | hvigor 编译 HAP（ArkTS strict + CMake）+ 宿主 headless Edge 驱动 H5（mock `nativeBridge` 应答全部 op）+ 真服务 `/api/ocr` 复核契约 | HAP `BUILD SUCCESSFUL`；H5 63/63（滤镜/微调/旋转/裁剪/非凸校验/导出/删除/OCR 面板与失败提示）；`sample_doc.jpg` 返回 11 行、points 均在图内，移植的阅读顺序输出通顺；未在真机运行 |
| 桌面 C ABI / CLI | Windows（MinGW-w64 16.2 + CMake 4.4）+ Linux（GCC 11 + CMake 3.22）编译运行 | C++ 自检 22/22；CLI 四滤镜、JPEG/PNG/BMP/TGA 均输出正确；DLL 只依赖 `KERNEL32` + UCRT |
| 桌面 Python / Java | ctypes（3.12 Windows / 3.10 Linux）+ JNI（JDK 17，Windows 与 Linux） | Python 13/13；Java 16/16；`nm`/`objdump` 确认 3 个 `ic_*` 与 3 个 `Java_*` 导出 |

测试脚本位于开发机 `D:\tools-src\wsl\lib\`，不随仓库提交；桌面端的四组自检在仓库内
（`modules/image-core/desktop/tests/`），Windows / macOS / Linux 的 CI 见
`.github/workflows/desktop-image-core.yml`。

---

## 14. 决策记录（ADR）

### ADR-1：算法用共享 C++，而不是各平台各写一遍

- **理由**：三端像素语义一致，算法只需维护一份；宿主侧可直接编译验证。
- **代价**：桥接层仍需三份（JNI / ObjC++ / NAPI），filter id 映射重复。

### ADR-2：原生模块 + WebView Canvas 双引擎，而不是纯 JS 或 WASM

- **纯 JS 否决**：Hermes 无 JIT，1 MP 图 1–2 分钟，不可接受。
- **WASM 否决**：需要额外工具链与加载器，收益不如直接原生；Expo Go 仍跑不了。
- **双引擎收益**：Expo Go 里也能完整演示；有原生模块时性能最好。
- **代价**：两套实现需要像素级对齐测试。

### ADR-3：原生路径用文件 I/O，不走 base64

- **理由**：1 MP 图的 base64 约 1.4 MB，跨桥字符串拷贝和 JS 内存压力都大；
  原生直接读文件、写文件，只传路径和统计值。
- **代价**：原生路径要求可读写的真实文件，示例资源需要先落盘（§12.3）。

### ADR-4：WebView 作为常驻单例，而不是每次调用新建

- **理由**：WebView 初始化成本高；常驻一个 1×1 隐藏实例，复用页面与 JIT 热代码。
- **代价**：全局可变状态（`post` / `inject` / `pending`），需要处理卸载与超时。

### ADR-5：鸿蒙 UI 用 H5 + ArkWeb，而不是 ArkTS 原生 UI

- **理由**：HarmonyOS NEXT 没有 AOSP 层，React Native / Expo 不能直接运行；
  H5 复用同一套交互（编辑器布局、裁剪手势、导出流程），算法仍通过 NAPI 走 C++。
- **代价**：两层桥（H5 ↔ ArkTS ↔ NAPI），页面与原生端状态需手动同步。

### ADR-6：路由用状态机，暂不引入 Expo Router

- **现状**：`App.tsx` 用联合类型切换页面；`route` 之外单独维护 `tab`，底部五个
  入口（首页/全部文档/相机/工具箱/我的）在 `home` 这一条路由里切换。与
  `AGENTS.md` 中“导航统一用 Expo Router”的约定不一致，属于当前实现的已知偏差。
- **理由**：页面互斥、层级浅，没有深链和返回栈需求；`tab` 独立于 `route`，从
  相机/编辑器返回时能停在原来的 tab 上。demo 阶段减少依赖。
- **迁移路径**：把 `src/screens/*` 移到 `src/app/`，用 `_layout.tsx` + 文件路由，
  `router.push({ pathname: '/editor', params: { ... } })`；`ScanDoc` 通过参数 id
  查询，避免把大对象塞进 URL。

### ADR-7：进入编辑器先缩到最长边 1400 px

- **理由**：Canvas 路径的内存/传输成本、原生编码成本都与像素数线性相关；
  1400 px 对手机查看足够。
- **代价**：保存的不是原始分辨率；未来做 OCR/PDF 需要保留原图或提高阈值。

### ADR-8：黑白用全局 Otsu，而不是固定阈值

- **理由**：文档亮度分布随拍摄条件变化大，固定阈值在不同光照下效果不稳定；
  Otsu 无需调参，双峰假设对文档成立。
- **代价**：多一次全图扫描；对低对比度或大面积阴影的图仍会失败（未做局部阈值）。

---

## 15. 扩展点

### 15.1 新增算法

列表、顺序、标签都集中在 `src/lib/filters.ts`，增删算法不再改界面代码。
按顺序改：

1. `src/lib/filters.ts`：`FilterKey` + `FILTER_LABELS` + `SCAN_FILTERS`
   （`SCAN_FILTERS` 决定展示顺序，删掉一项即隐藏）；
2. `modules/image-core/common/image_core.h`：加枚举值；
3. `image_core.cpp`：实现 `apply_xxx` 并加入 `switch`；
4. `src/lib/filterEngine.tsx`：HTML 里加同名分支（公式必须与 C++ 一致）；
5. 三个桥的 `filterId` 映射：Kotlin、Swift、ArkTS；
6. 契约脚本与像素对比脚本补用例。

只做 UI 实验时，可以只改第 1 步——未实现的 key 在 Canvas 里会原样返回，
但正式功能必须补齐 2–5，否则该平台会静默不处理。

### 15.2 新增平台

实现四件事：

1. 解码到 `0xAARRGGBB` 的连续缓冲区；
2. 调用 `image_core::process_pixels`；
3. 把缓冲区编码回 JPEG（质量参数 1–100）；
4. 返回与 `NativeProcessResult` 相同的字段。

### 15.3 功能方向

| 功能 | 建议落点 |
|---|---|
| 边缘检测 | 已接端侧模型：Android DocCornerNet ONNX、iOS Vision（`nativeDocumentDetector.ts`）；相机预览实时四角、导入/拍照自动切边；配置了服务端时手动裁剪改问 model_1228（`detectionServer.ts`） |
| 鸿蒙 OCR | 已完成（服务端）：H5「提取文字」→ `Index.ets` 的 `ocr` op → 短边 1600 JPEG → `POST /api/ocr` → 与 RN 同口径的阅读顺序拼行 → 结果面板（可复制）。没有端侧模型，必须先在「识别服务」里配置地址 |
| 鸿蒙切边 | 共享 C++ 内核里再补一份检测（或 NAPI 调 ONNX Runtime），H5 侧沿用现有四角入口 |
| ONNX 批量推理 / 低内存 | 有界并发 + session 复用 + 降采样解码，见 [EDGE_DETECTION.md](EDGE_DETECTION.md) §5 |
| 手动批注 | `DocPage.annotations` 已预留（扫描与 PDF 共用）；建议渲染成位图写回 `uri`，避免 PDF 阶段再合成 |
| 大页数 PDF | 原生流式 writer 替换 expo-print，见 [EDGE_DETECTION.md](EDGE_DETECTION.md) §6 |
| PDF 端也换应用内选择器 | `PdfScreen` 仍用 `expo-image-picker`；把 `PhotoPickerScreen` 接进去即可与扫描统一 |
| 扫描 → PDF | `ScanDoc.pages` 与 `PdfDoc.pages` 同构，可直接复用 `generatePdf` 与排版页 |
| 取消计算 | 原生桥增加 request id + 取消标志，避免快速切换浪费（JS 侧已有 `AbortSignal`） |
| OCR | 保存后异步跑 ML Kit / PaddleOCR，结果单独存索引 |

### 15.4 迁移到 Expo Router

见 ADR-6。迁移后 `App.tsx` 只保留 Provider 与 `FilterEngineHost`，页面放到
`src/app/`，非路由组件继续留在 `src/`。

---

## 16. 构建与发布

### 16.1 CNG（Continuous Native Generation）

- `android/`、`ios/` 不提交，由 `expo prebuild` 生成；
- 原生配置只写在 `app.json` / config plugin 里；
- JS 侧新增原生依赖后必须重新 prebuild / 重新构建 development build。

### 16.2 Android

```bash
npx expo prebuild --platform android   # 仅在 android/ 不存在时需要
cd android && ./gradlew assembleRelease --no-daemon
```

- `minSdkVersion = 28`（`expo-build-properties`）；
- ABI 默认 `armeabi-v7a, arm64-v8a, x86, x86_64`，APK 约 97 MB；
- `release` 使用模板自带的 **debug keystore**，仅用于内部测试；
- R8 / 资源压缩按模板默认配置。

**Windows 特有问题**（本机已绕过）：

1. CMake 对象路径镜像源码绝对路径，`react-native-safe-area-context` 原路径会超过
   260 字符。把包实体放到 `D:\n\sacontext`，在 `node_modules` 下建 junction；
   `metro.config.js` 增加该目录的 `watchFolders` 与项目 `nodeModulesPaths`。
2. RN settings 插件按 `package.json` / lockfile 哈希缓存 autolinking 结果。移动依赖
   后必须删除 `android/build/generated/autolinking` 和 `android/app/.cxx`。
3. 不要用 `subst` 盘符构建：项目与依赖不在同一盘根时，Gradle codegen 会报
   `this and base files have different roots`。

### 16.3 iOS

工作流 `.github/workflows/ios-unsigned-ipa.yml`：

1. `macos-15` + Node 22 + `npm ci`；
2. `npx expo prebuild --platform ios --no-install`；
3. `pod install`；
4. `xcodebuild -configuration Release -sdk iphoneos CODE_SIGNING_ALLOWED=NO`；
5. 把 `.app` 放进 `Payload/` 打成 `app-unsigned.ipa`，上传 artifact。

未签名 IPA 需用 Sideloadly / AltStore 侧签；正式分发需要 Apple Developer 账号与
签名配置。

### 16.4 HarmonyOS

工具链：OpenHarmony SDK 5.0.0.71（API 12）+ hvigor 5.16.2。

```bash
cd harmony
ohpm install
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

产物 `entry/build/default/outputs/default/entry-default-unsigned.hap`，包含
`libs/arm64-v8a/libimage_core.so`、`resources/rawfile/*`、`ets/modules.abc`。
未签名，安装需要 DevEco 自动签名或手动证书。详见 `harmony/README.md`。

---

## 17. 已知限制与风险

1. **无文档几何处理**：没有边缘检测与透视校正，拍摄角度直接影响结果。
2. **EXIF 方向**：Android `BitmapFactory` 不处理 EXIF 旋转；相机输出通常已摆正，
   但相册里带方向标记的图片可能在原生处理后方向不对。未做专门验证。
3. **预乘 alpha**：iOS 用 `premultipliedFirst`，带透明通道的输入会与直通道实现
   有差异；文档场景均为不透明图，暂不处理。
4. **不取消计算**：快速切换滤镜会丢弃旧结果，但旧的原生计算仍会跑完。
5. **两套实现的漂移风险**：C++ 与 Canvas 的公式、filter id 映射需要人工同步；
   目前靠契约脚本和像素对比兜底。
6. **iOS / 鸿蒙未真机运行**：桥接与算法在宿主侧验证，平台 API 层（UIKit、
   ImageKit、ArkWeb）只经过编译与代码审查。
7. **存储一致性**：文件与索引分开写，异常时可能留下孤儿图片；没有事务与清理。
8. **Release 签名**：debug keystore，不可上架。
9. **路由约定偏差**：未使用 Expo Router（ADR-6）。
10. **扫描文档没有 PDF 导出**：`ScanDoc` 已支持多页，但导出仍只有「保存到相册」；
    生成 PDF 需要走「图片转 PDF」重新导入（两者页面结构相同，后续可直接打通）。
11. **PDF 页数受内存限制（15–60 页）**：expo-print 需要整份 HTML 在内存里；
    分档规则是估算值，低端机可能仍需拆分成多个 PDF。超出要走原生流式写入
    （[EDGE_DETECTION.md](EDGE_DETECTION.md) §6）。
12. **PDF 生成失败会整份重来**：expo-print 没有分页写入或断点续传，重新生成会重读
    所有页面。页面源图不删，所以数据不会丢。
13. **批注未实现**：`DocPage.annotations` 只有数据类型和入口，没有渲染层；切边已由
    端侧模型实现（Android DocCornerNet / iOS Vision），鸿蒙端仍只有手动四角。
14. **`expo-print` 的 `numberOfPages` 是估算值**：Android 端按
    `1 + contentHeight / pageHeight` 计算，可能与实际页数不一致，仅用于日志。

---

## 18. 术语与关键文件索引

| 术语 | 含义 |
|---|---|
| 原生路径 | 通过 Expo Module 调用平台桥 + C++ 内核 |
| Canvas 路径 | 隐藏 WebView 里的 Canvas 2D 实现 |
| 基础图 | `prepareBase` 缩放后的图，所有滤镜的输入 |
| Otsu | 最大化类间方差的全局二值化阈值算法 |
| CNG | Continuous Native Generation，`android/`、`ios/` 由 prebuild 生成 |

| 关注点 | 文件 |
|---|---|
| 滤镜算法 | `modules/image-core/common/image_core.cpp` |
| 像素契约 | `modules/image-core/common/image_core.h` |
| Android 桥 | `modules/image-core/android/src/main/java/expo/modules/imagecore/ImageCoreModule.kt` |
| JNI | `modules/image-core/android/src/main/cpp/jni_bridge.cpp` |
| iOS 桥 | `modules/image-core/ios/ImageCoreModule.swift`、`ImageCoreBridge.mm` |
| 鸿蒙桥 | `harmony/entry/src/main/cpp/napi_init.cpp`、`.../image/ImageCoreService.ets` |
| 鸿蒙页面 | `harmony/entry/src/main/ets/pages/{Index,PdfPage}.ets`、`rawfile/index.html` |
| 鸿蒙 PDF | `harmony/entry/src/main/ets/pdf/PdfWriter.ets`（JPEG→PDF，DCTDecode） |
| Canvas 引擎 | `src/lib/filterEngine.tsx` |
| 引擎选择 | `src/lib/filterNative.ts`、`src/lib/imagePipeline.ts` |
| 存储（扫描） | `src/lib/storage.ts` |
| 页面文件 | `src/lib/pageStore.ts` |
| PDF 生成 | `src/lib/pdf.ts` |
| PDF 存储 | `src/lib/pdfStorage.ts` |
| 切边接口 | `src/lib/documentDetection.ts`、`nativeDocumentDetector.ts`、`detectionServer.ts` |
| OCR | `src/lib/ocrLocal.ts`、`ocrServer.ts`、`ocrStorage.ts`、`src/screens/OcrScreen.tsx` |
| 相册选择器 | `src/screens/PhotoPickerScreen.tsx` |
| 多页扫描编辑 | `src/screens/ScanEditorScreen.tsx` |
| 单页编辑 | `src/screens/EditorScreen.tsx`（`showPageTools`）、`src/screens/PdfScreen.tsx` |
| 路由 | `App.tsx` |
| 多语言运行时 | `src/lib/i18n.ts`、`src/lib/locales/*.ts`（7 种语言词典） |
| 系统级文案 | `locales/*.json`（9 种语言）、`app.json` 的 `locales` |
| 构建配置 | `app.json`、`metro.config.js`、`.github/workflows/ios-unsigned-ipa.yml` |
