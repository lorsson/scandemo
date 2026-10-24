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
4. **完整闭环**：拍照或导入 → 预览滤镜 → 旋转 → 保存 → 历史 → 导出/删除。
5. **图片转 PDF**：多选导入 → 排序 → 生成 → 分享；生成前后都能对单页做增强/旋转。
6. **可验证**：每个平台都能在没有真机的条件下验证桥接与算法。

## 2. 非目标

- 不实现文档边缘检测、透视校正、去阴影、去手写（四角检测/切边只预留接口与数据
  结构，见 [EDGE_DETECTION.md](EDGE_DETECTION.md)）。
- 不做 OCR、云端同步。
- 不做不限页数的 PDF：`expo-print` 需要整份 HTML 进内存，页数按设备内存
  限制在 15–60 页；原生流式 writer 的设计见
  [EDGE_DETECTION.md](EDGE_DETECTION.md) §6（鸿蒙端已实现）。
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
│ pdf.ts：逐页 base64 → HTML → expo-print → 沙盒 document.pdf        │
│ documentDetection.ts：ONNX 四角 / 切边（预留，未接原生）             │
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
│ 纯 C++17，无平台依赖，只改像素，不解码/编码                          │
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
| 入口 / 路由 | `App.tsx` | 路由状态机、文档/PDF 列表增删、权限与相册入口 |
| 页面 | `src/screens/*` | 首页、相机、编辑器、详情、PDF 排版 |
| 编排 | `src/lib/imagePipeline.ts` | 资源解析、尺寸读取、缩放、旋转、读 base64 |
| 引擎选择 | `src/lib/filterNative.ts` | 探测原生模块、文件路径转换、调用与计时日志 |
| 回退引擎 | `src/lib/filterEngine.tsx` | 隐藏 WebView、消息协议、超时、Canvas 滤镜 |
| 持久化 | `src/lib/storage.ts` | 沙盒文件 + AsyncStorage 索引 |
| PDF 生成 | `src/lib/pdf.ts` | 页数上限、分辨率策略、HTML 排版、打印与落盘 |
| PDF 存储 | `src/lib/pdfStorage.ts` | 项目目录、源图/缩略图/编辑图、索引 |
| 切边接口 | `src/lib/documentDetection.ts` | ONNX 检测 / 批量 / 透视变换的 JS 契约（预留） |
| 类型 | `src/types.ts` | `FilterKey`、`ScanDoc`、`PdfDoc`、`DocumentQuad`、文案 |
| 原生桥 | `modules/image-core/*` | Expo 模块封装、平台解码/编码、JNI/NAPI |
| 算法 | `modules/image-core/common/*` | 纯 C++ 像素处理 |
| 鸿蒙 | `harmony/` | ArkTS 工程、ArkWeb 页面、NAPI 注册 |

约束：`src/app/` 目录不存在，路由不用 Expo Router；这是当前实现，不是规范（见 §14 ADR-6）。
非路由代码全部放在 `src/` 下。

---

## 5. 数据流与时序

### 5.1 输入

| 来源 | 实现 | 拿到的 URI |
|---|---|---|
| 拍照 | `CameraView.takePictureAsync({ quality: 0.9 })` | 缓存目录文件 URI |
| 相册 | `ImagePicker.launchImageLibraryAsync` | `file://` 或 `content://` |
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

### 5.4 保存与历史

```
handleSave
  ├─ original → readBase64(currentUri)
  ├─ native   → readBase64(processed.uri)
  ├─ canvas   → 去掉 data URL 前缀
  └─ onSave({ base64, filter, title })
       ├─ persistImage(base64, id)   // documentDirectory/scans/<id>.jpg
       ├─ ScanDoc 插入列表头部
       ├─ AsyncStorage.setItem('scans.index.v1', JSON)
       └─ 回到首页
```

### 5.5 导出

`DocumentScreen` 用 `expo-media-library/legacy` 的
`requestPermissionsAsync(true)` + `saveToLibraryAsync(doc.uri)`。

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
`PdfPage.uri` 与 `filter`，`originalUri` 保持不变。

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
        └─ 更新 PdfPage → updatedAt 变化 → 回到 PdfScreen → 提示重新生成
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
enum Filter : int32_t { kOriginal = 0, kGray = 1, kBw = 2, kEnhance = 3 };
void process_pixels(uint32_t* pixels, int32_t width, int32_t height, int32_t filter);
const char* version();
}
```

- `pixels == nullptr` 或宽高非正：直接返回。
- 未知 filter：按 original 处理。
- `version()` 当前返回 `image-core/0.1.0`。

### 6.3 filter id 的跨端一致性

字符串到 id 的映射在四个地方重复（Android Kotlin、iOS Swift、鸿蒙 ArkTS、Canvas JS），
这是当前设计中最容易漂移的点：

| 字符串 | id |
|---|---|
| `original` | 0 |
| `gray` | 1 |
| `bw` | 2 |
| `enhance` | 3 |

跨端契约脚本会检查这些字面量。

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

### 7.5 原图（original）

C++ 空操作；JS 直接返回输入。保留该枚举是为了契约完整和 UI 一致性。

### 7.6 复杂度

| 滤镜 | 时间 | 额外内存 |
|---|---|---|
| gray | O(N) | O(1) |
| bw | O(N) + O(256) | 1 KB 直方图 |
| enhance | O(N) | O(1) |
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

JNI 错误码：`-1` 参数非法、`-2` 数组长度不足、`-3` 取指针失败；Kotlin 侧
`check(result == 0)` 抛异常给 JS。

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

`decodeMs` 只覆盖 `UIImage` 加载；`CGContext.draw` 的耗时计入 `totalMs` 但不属于
任何一段，这是与 Android 口径的细微差别。

`ImageCore.podspec` 把 `../common/*.{h,hpp,cpp}` 一起编进 pod，`static_framework = true`。

### 8.3 HarmonyOS

- **NAPI 注册**：`napi_init.cpp` 导出 `version()` 与
  `processPixels(buffer, width, height, filter)`；校验参数个数、ArrayBuffer、
  `width/height > 0`、`byteLength >= w*h*4`，失败抛 `TypeError` / `RangeError`。
  模块名 `image_core`，与 `import imageCore from 'libimage_core.so'` 对应。
- **解码/编码**：`ImageCoreService.ets` 用 `image.createImageSource(fd)` 解码，
  请求 `BGRA_8888`；`readPixelsToBuffer` 得到 `ArrayBuffer`；NAPI 原位修改；
  `writeBufferToPixels`；`ImagePacker.packing(pixelMap, {format:'image/jpeg',
  quality})`；最后写文件。所有句柄在 `finally` 里 `release/close`。
- **UI**：`Index.ets` 用 `<Web src=$rawfile('index.html')>`，通过
  `javaScriptProxy` 注入 `dispatch` / `version`；启动时把 `rawfile/sample.jpg`
  复制到 `cacheDir`，页面加载完用 `runJavaScript` 调 `window.__init(path)`。
- **协议**：H5 发 JSON `{id, input, output, filter, quality}`；ArkTS 处理完用
  `window.__onNativeResult(result)` 回推。刻意不用 Promise 跨 JS Proxy 返回。

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
 │── postMessage({id,b64,filter}) ──────►│
 │   （1.5s 内没被处理则 injectJavaScript 再发一次）
 │                                       │ img.onload → 逐像素
 │                                       │ canvas.toDataURL(JPEG,0.9)
 │◄── {id,ok,dataUrl,ms,width,height} ───│
 │                                       │
 │  15s 启动超时 / 25s 单次超时           │
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

量化差异见 §13.2。

---

## 10. UI 与状态管理

### 10.1 路由

`App.tsx` 用联合类型做状态机：

```ts
type Route =
  | { name: 'home' }
  | { name: 'camera' }
  | { name: 'editor'; sourceUri: string; title: string }
  | { name: 'doc'; doc: ScanDoc };
```

没有 URL、没有深链、没有返回栈；四个页面互斥渲染。优点是实现小、状态直观；
缺点是系统返回键没有接管、无法深链。迁移到 Expo Router 的路径见 §15.4。

### 10.2 编辑器状态

```ts
currentUri   // 已缩放的基础图
filter       // 当前选中的滤镜
processed    // { key, uri, source: 'native' | 'canvas' }
processing   // 遮罩
saving
error
reqId        // 竞态保护
```

关键点：

- 切到 `original` 不清空 `processed`，预览直接用 `currentUri`；切回其他滤镜时重新计算。
- `processing` 在选滤镜的事件处理器里立即置 true，避免“点完没反应”。
- 出错时显示中文错误文案，保存失败不会卡在“保存中”。

### 10.3 页面职责

| 页面 | 职责 |
|---|---|
| Home | 扫描三入口、图片转 PDF 入口、PDF 列表、文档列表、长按/按钮删除、空状态 |
| Camera | 权限申请、取景框、快门、相册入口 |
| Editor | 预处理、滤镜切换、旋转、保存；`showPageTools` 时额外显示切边/批注/恢复原图 |
| Document | 整图查看、导出相册、删除确认 |
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

---

## 11. 存储与数据模型

```ts
type ScanDoc = {
  id: string;        // Date.now() 字符串
  uri: string;       // 沙盒内整图 file://
  thumbUri: string;  // demo 中与 uri 相同
  filter: FilterKey;
  createdAt: number;
  title: string;     // “示例文档 10-23 2327”
};
```

| 数据 | 位置 |
|---|---|
| 图片 | `FileSystem.documentDirectory + 'scans/<id>.jpg'` |
| 索引 | AsyncStorage，key `scans.index.v1`，JSON 数组 |

- `loadDocs` 解析失败返回空数组，不让坏索引阻塞启动。
- `removeImage` 使用 `idempotent: true`，文件不存在也视为成功。
- 索引先写列表再落盘；如果 `persistImage` 成功而 `saveIndex` 失败，会留下孤儿文件。
  当前没有清理任务（见 §17）。

### 11.1 PDF 数据模型

```ts
type PdfDoc = {
  id: string;
  title: string;
  pages: PdfPage[];
  uri: string | null;        // 生成的 PDF；未生成时为 null
  pageCount: number;
  createdAt: number;
  updatedAt: number;         // 任何页面变化
  generatedAt: number | null;
  defaultFilter: FilterKey;  // 新导入图片自动使用的算法
};

type PdfPage = {
  id: string;
  originalUri: string;       // 导入时写入，永不修改
  uri: string;               // 当前参与生成的图（可能是 edited/）
  thumbUri: string;          // 220px，列表专用
  filter: FilterKey;
  rotation: 0 | 90 | 180 | 270;
  cropQuad?: DocumentQuad | null;      // 预留
  annotations?: PageAnnotation[];      // 预留
};
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
  ├─ 是 → processFile（文件路径）
  └─ 否 → WebView Canvas（base64 data URL）
           └─ 引擎 15s 未就绪 / 单次 25s 超时 → 报错“滤镜处理失败”
```

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

### 13.4 测试矩阵

| 项目 | 方式 | 结果 |
|---|---|---|
| WebView 引擎 | headless Edge 执行真实 HTML，11 项引擎 + 9 项 H5 | 20/20 |
| Android NAPI 桥 | `napi_init.cpp` 编为 Node 插件 | 10/10 + 12 MP 计时 |
| iOS 桥 | `ImageCoreBridge.mm` 编到 Linux | 16/16 |
| 跨端契约 | filter id、像素布局、字段、模块名 | 44/44 |
| Android 应用 | 模拟器安装 release APK，示例文档→三种滤镜→保存→首页记录 | 通过（相机/相册导出未在模拟器验证） |
| 图片转 PDF | 模拟器 debug APK：多选导入→排序→生成→单页灰度→重新生成→分享 | 通过（1/3 页 PDF 均为 A4，页数正确） |
| Expo Go PDF | 无原生模块，base64 兜底 | 通过（自动重试并写盘） |
| 自动算法 / 批量应用 | 模拟器 debug APK：导入 2 张 → 单页改黑白 → 批量改回增强 → 重启 | 通过（导入即增强、单页覆盖生效、批量前有覆盖提示、重启后状态保留） |
| 页数自适应 | 模拟器 1.5 GB RAM / 384 MB 堆，看页脚与上限 | 通过（判定 15 页 / 1200 px；2 页 PDF 仍为 A4） |
| 鸿蒙 PDF | hvigor 编译 HAP + `PdfWriter.ets` 源码在宿主用 `fileIo` 桩运行 + `pdf-lib` 解析 | 13/13 字节校验（1/2 页）、独立解析 2 页 A4；未在真机/模拟器运行 |

测试脚本位于开发机 `D:\tools-src\wsl\lib\`，不随仓库提交。

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
  H5 复用同一套交互与 Canvas 滤镜演示，算法仍通过 NAPI 走 C++。
- **代价**：两层桥（H5 ↔ ArkTS ↔ NAPI），页面与原生端状态需手动同步。

### ADR-6：路由用状态机，暂不引入 Expo Router

- **现状**：`App.tsx` 用联合类型切换四个页面。与 `AGENTS.md` 中“导航统一用
  Expo Router”的约定不一致，属于当前实现的已知偏差。
- **理由**：只有四个互斥页面，没有深链和返回栈需求；demo 阶段减少依赖。
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

### 15.1 新增滤镜

按顺序改：

1. `modules/image-core/common/image_core.h`：加枚举值；
2. `image_core.cpp`：实现 `apply_xxx` 并加入 `switch`；
3. `src/types.ts`：`FilterKey` + `FILTER_LABELS`；
4. `src/lib/filterEngine.tsx`：HTML 里加同名分支（保持公式一致）；
5. 三个桥的 `filterId` 映射：Kotlin、Swift、ArkTS；
6. `src/screens/EditorScreen.tsx` 的 `FILTERS` 数组；
7. 契约脚本与像素对比脚本补用例。

### 15.2 新增平台

实现四件事：

1. 解码到 `0xAARRGGBB` 的连续缓冲区；
2. 调用 `image_core::process_pixels`；
3. 把缓冲区编码回 JPEG（质量参数 1–100）；
4. 返回与 `NativeProcessResult` 相同的字段。

### 15.3 功能方向

| 功能 | 建议落点 |
|---|---|
| 边缘检测 / 透视校正 | 已定契约：`src/lib/documentDetection.ts`；原生 warp 放共享 C++，见 [EDGE_DETECTION.md](EDGE_DETECTION.md) |
| ONNX 批量推理 / 低内存 | 有界并发 + session 复用 + 降采样解码，见 [EDGE_DETECTION.md](EDGE_DETECTION.md) §5 |
| 手动批注 | `PdfPage.annotations` 已预留；建议渲染成位图写回 `uri`，避免 PDF 阶段再合成 |
| 大页数 PDF | 原生流式 writer 替换 expo-print，见 [EDGE_DETECTION.md](EDGE_DETECTION.md) §6 |
| ScanDoc 缩略图 | 保存时生成 200 px 版本，`thumbUri` 指向它（PDF 页面已经这么做） |
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
10. **扫描记录是单页模型**：`ScanDoc` 只有一张图；多页能力在独立的 `PdfDoc` 上实现。
11. **PDF 页数受内存限制（15–60 页）**：expo-print 需要整份 HTML 在内存里；
    分档规则是估算值，低端机可能仍需拆分成多个 PDF。超出要走原生流式写入
    （[EDGE_DETECTION.md](EDGE_DETECTION.md) §6）。
12. **PDF 生成失败会整份重来**：expo-print 没有分页写入或断点续传，重新生成会重读
    所有页面。页面源图不删，所以数据不会丢。
13. **切边与批注未实现**：只有数据类型、JS 契约和 UI 入口，没有模型与渲染层。
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
| 存储 | `src/lib/storage.ts` |
| PDF 生成 | `src/lib/pdf.ts` |
| PDF 存储 | `src/lib/pdfStorage.ts` |
| 切边接口 | `src/lib/documentDetection.ts` |
| 单页编辑 | `src/screens/EditorScreen.tsx`（`showPageTools`）、`src/screens/PdfScreen.tsx` |
| 路由 | `App.tsx` |
| 构建配置 | `app.json`、`metro.config.js`、`.github/workflows/ios-unsigned-ipa.yml` |
