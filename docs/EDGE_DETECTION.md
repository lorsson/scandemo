# 文档边缘检测、透视切边与大批量处理（预留接口）

本文对应两类「还没接原生实现、但接口和数据结构已经定好」的能力：

1. **ONNX 文档四角检测 + 透视切边**（`src/lib/documentDetection.ts`）；
2. **大批量图片 / 低内存设备上的批处理策略**，以及为什么当前 PDF 生成上限是
   50 页、以及突破它的路径。

> 相关代码：
> [documentDetection.ts](../src/lib/documentDetection.ts)、
> [pdf.ts](../src/lib/pdf.ts)、
> [pdfStorage.ts](../src/lib/pdfStorage.ts)、
> [types.ts](../src/types.ts)。
> 滤镜部分的像素契约见 [DESIGN.md §6](DESIGN.md#6-像素契约与共享内核)。

---

## 1. 现状

| 能力 | 状态 |
|---|---|
| `PdfPage.cropQuad` / `PdfPage.annotations` 字段 | ✅ 已落库，可持久化 |
| 归一化四角类型 `DocumentQuad` / `NormalizedPoint` | ✅ 已定义 |
| JS 侧 `detectDocumentQuad` / `detectDocumentBatch` / `warpDocumentQuad` | ✅ 接口可用，默认 detector 不可用 |
| 单页编辑器里的「✂ 切边」「✎ 批注」入口 | ✅ 已展示，点击提示「接口已预留」 |
| ONNX 模型、原生推理、透视变换 | ❌ 未实现 |

因此 UI 必须先用 `isEdgeDetectionAvailable()` 判断，再决定是否把「切边」做成可用
按钮；直接调用会抛 `文档边缘检测尚未接入（预留了 ONNX 接口）`。

---

## 2. 目标流程

```
导入图片
  → [检测] 缩放到 512×512 → ONNX 推理 → 四角（归一化）
  → [确认] 用户在预览上拖动四角（可选）
  → [切边] 原图 + 四角 → 透视变换 → 拉正后的 JPEG
  → [增强] 现有 C++ 滤镜
  → 写入 PdfPage.uri / cropQuad
  → 生成 PDF
```

检测和切边是**两个可以分开调用**的步骤：检测结果（4 个点）很小，可以先批量算完，
再让用户逐页确认；切边是重操作，只在需要时对单张图执行。

---

## 3. JS 接口契约

### 3.1 检测

```ts
const det = await detectDocumentQuad(page.originalUri);
if (det && det.confidence >= 0.5) {
  // 把 det.quad 写进 PdfPage.cropQuad 并落盘，等用户确认后再切边
  const nextPage = { ...page, cropQuad: det.quad };
}
```

- 返回 `{ quad, confidence }` 或 `null`（图中没有可识别的文档）。
- `confidence` 取 `[0,1]`，阈值由 UI 决定；建议低于 0.5 时不自动应用。
- 实现内部应把图解码到模型输入尺寸（常见 512×512），推理完立即释放全尺寸位图。

### 3.2 切边

```ts
const { uri } = await warpDocumentQuad(page.originalUri, quad, { maxDim: 1800 });
```

- 输出与输入同宽高比、最长边不超过 `maxDim`（默认 1600）的 JPEG 文件。
- 输入永远是 `page.originalUri`，不要拿 `page.uri` 做二次切边（会累积重采样损失）。
- 成功后把 `uri` 写入 `page.uri`，`cropQuad` 写入 `page.cropQuad`；「恢复原图」只需
  把 `uri` 指回 `originalUri` 并清空 `cropQuad`。

### 3.3 批量

```ts
const results = await detectDocumentBatch(uris, {
  concurrency: 1,      // 低端机保持 1
  batchSize: 2,        // 仅当 detector 实现 detectBatch 时生效
  onProgress: (done, total) => setProgress(done / total),
});
```

- 返回数组与输入一一对应，未检测到的位置是 `null`。
- 原生 detector 若实现 `detectBatch`，框架会一次性交给它；否则按 `concurrency`
  做有界并发，默认 **1**。

### 3.4 四角顺序

固定为顺时针 `topLeft → topRight → bottomRight → bottomLeft`，坐标为相对原图的
归一化值 `[0,1]`。用归一化坐标的原因：

- 与图片分辨率解耦，原图被重新压缩/缩放后旧结果仍然有效；
- 存进 AsyncStorage 只是 8 个浮点数，几百页也不占空间；
- 渲染层按当前显示尺寸换算即可，不需要知道原图尺寸。

`isQuadInRange()` 会检查数值范围和大致顺序，原生结果回来后可做一次防御性校验。

---

## 4. 原生接入约定

### 4.1 三端分工

| 平台 | 推理 | 解码/编码 | 透视变换 |
|---|---|---|---|
| Android | ONNX Runtime + NNAPI/QNN EP | `BitmapFactory`（`inSampleSize` 降采样） | 共享 C++ |
| iOS | ONNX Runtime + Core ML EP | `CGImageSource` 缩略图解码 | 共享 C++ |
| 鸿蒙 | ONNX Runtime（NNRt）或 MindSpore Lite | `ImageSource` / PixelMap | 共享 C++ |

透视变换（`warpPerspective` + 双线性插值）建议放进共享 C++
（`modules/image-core/common/`），与现有滤镜共用一套像素契约，各平台只负责
「解码 → 交指针 → 收指针 → 编码」。这样三端只需要验证一次算法。

### 4.2 实现约束

- **session 复用**：ONNX session 创建代价高（几十到几百 ms），必须在模块初始化时
  创建一次并复用；不要每次 `detect` 都建。
- **降采样解码**：12 MP 的图直接解码成 RGBA 是 48 MB。Android 必须用
  `inSampleSize` 直接解到接近 512×512；iOS 用
  `CGImageSourceCreateThumbnailAtIndex`。这一步决定了低端机能不能跑。
- **不要跨调用缓存位图**：`detect` 返回后位图即可释放；只有数字进入 JS。
- **线程**：推理放在后台线程/队列，JS 线程只等 Promise；`signal` 被 abort 时尽快
  返回。
- **失败要能降级**：模型缺失、EP 初始化失败、输入损坏都返回 `null` 或抛可识别
  错误，UI 退回「不切边」的流程。

### 4.3 模型建议

| 项 | 建议 |
|---|---|
| 输入 | 512×512 RGB（归一化到 `[0,1]` 或 ImageNet mean/std，跟训练一致） |
| 输出 | 4 点回归（8 个值）或角点热图（4 通道），取 argmax + 亚像素细化 |
| 体积 | 量化后 2–8 MB；超过 10 MB 会明显拖慢冷启动 |
| 量化 | INT8 动态量化，精度不够时只量化权重 |
| 兜底 | 检测失败时用「整图 + 轻微内缩」当四角 |

---

## 5. 低内存设备上的批量处理

### 5.1 内存到底花在哪

处理 N 张图时，峰值内存近似为：

```
峰值 ≈ 单张解码位图 + 模型输入/输出 + 常驻 JS 堆 + 当前可见缩略图
        （与 N 无关的部分）                      （与 N 无关的部分）
      + batchSize × 模型输入位图                ← 唯一跟批量有关的部分
```

关键数字（以 512×512 RGB 为例）：

| 数据 | 大小 |
|---|---|
| 模型输入，uint8 | 0.75 MB / 张 |
| 模型输入，float32 | 3 MB / 张 |
| 12 MP 全尺寸位图（RGBA） | ≈ 48 MB / 张 |
| 220×293 缩略图（RGBA） | ≈ 0.25 MB / 张 |
| 四角结果（JS 对象） | ≈ 0.2 KB / 页 |

结论：

- **决定内存的是「同时在内存里的全尺寸位图数量」，不是图片总数。**
- 只要严格「一次解码一张、推理完立刻释放」，200 张和 2 张的峰值内存几乎一样。
- 因此本项目所有批量路径都写成串行 + 有界并发，而不是 `Promise.all(全部)`：
  - 导入：`persistPdfPages()` 逐张 缩放 → 拷贝 → 缩略图 → 释放；
  - 生成 PDF：`buildPdfHtml()` 逐页读 base64，拼完即释放文件内容；
  - 批量检测：默认 `concurrency = 1`。

### 5.2 batchSize 怎么选

| 设备 | batchSize | concurrency | 说明 |
|---|---|---|---|
| 2–3 GB RAM / 低端 | 1 | 1 | 只要不 OOM，速度靠「少解码」而不是并行 |
| 4–6 GB RAM / 中端 | 2 | 1–2 | 通常还有 200–400 MB 余量 |
| 8 GB+ / 旗舰 | 4 | 2 | 再大收益递减，NPU 往往内部串行 |

经验规则：`batchSize × 模型输入位图 × 2 < 可用内存余量`。按 float32 输入算，
batchSize=4 只占约 12 MB，真正危险的是**每张图的全尺寸解码**——这也是为什么
原生实现必须降采样解码，而不是先解全图再缩小。

### 5.3 速度与「支持多少张」的平衡

批量检测本身很快（512×512，端侧 NPU 单张几 ms），瓶颈在解码与 IO：

| 阶段 | 大致耗时（中端机） | 可否并行 |
|---|---|---|
| 解码 + 降采样 | 20–60 ms / 张 | 可以，但每并行一份就多一份位图 |
| ONNX 推理 | 5–30 ms / 张（CPU）/ 2–8 ms（NPU） | 批量化收益明显 |
| 透视变换 | 30–120 ms / 张（1800px 输出） | 可以，但输出位图同样占内存 |
| JPEG 编码 | 20–50 ms / 张 | 可以 |

因此推荐流水线：**解码(B=1) → 推理(B=2–4) → 切边(B=1) → 编码(B=1)**，各级之间
用容量为 1–2 的队列衔接。任一时刻只有 1–2 张全尺寸位图在内存里，总吞吐接近
「推理耗时 × 张数」，而内存是常数。

对「支持几百张」更重要的是**可分阶段、可恢复**：

1. 先只做检测，把四角落库（几十 KB），用户可以中途退出；
2. 再逐页切边/增强，每完成一页就写文件并更新索引；
3. 任何一步中断，重启后跳过已完成的页，只补未完成的。

这样即使中途被系统杀掉，也不会丢掉已经处理的几百页。

### 5.4 页数与质量的自适应

两层自适应，都在 `src/lib/pdfLimits.ts` + `src/lib/pdf.ts` 里：

**第一层：按设备内存定页数上限**

| 物理内存 | 页数上限 | 单页最长边 |
|---|---|---|
| ≤ 2 GB | 15 | 1200 px |
| ≤ 3 GB | 25 | 1400 px |
| ≤ 4 GB | 35 | 1600 px |
| ≤ 6 GB | 50 | 1600 px |
| > 6 GB | 60 | 1800 px |

Android 再用 JVM 堆上限收紧（`Device.getMaxMemoryAsync()`）：

| 堆上限 | 页数上限 |
|---|---|
| ≤ 128 MB | 10 |
| ≤ 192 MB | 15 |
| ≤ 256 MB | 25 |
| ≤ 384 MB | 35 |
| > 384 MB | 60 |

取物理内存档与堆档的较小值，再做 5–80 的硬夹取。`initPdfLimits()` 在 App
启动时调用一次，结果缓存在进程内；Expo Go / Web 拿不到设备信息时退回
20 页 / 1500 px。

**第二层：`pdfProfileFor(pageCount, limits)` 按页数降分辨率**

| 页数 | 最长边 | JPEG 质量 |
|---|---|---|
| ≤ 8 | 1800 px | 0.90 |
| ≤ 25 | 1500 px | 0.86 |
| > 25 | 1200 px | 0.82 |

最终 `maxDim` 再与第一层的单页上限取小。原因见下一节：expo-print 必须把
**整份 HTML（含所有 base64）**放进内存，页数越多，单页就必须越小。
接入原生流式写入后这个约束消失，可以改成「固定 1800 px、边写边压缩」。

---

## 6. 突破页数上限：原生流式 PDF 写入

`generatePdf()` 现在走 `expo-print`：HTML 字符串 → WebView 排版 → 输出 PDF。
整份 HTML 必须同时在内存里（base64 约为 JPEG 的 4/3 ≈ 1.33 倍），所以
页数上限（按内存 15–60 页，见 §5.4）是**内存限制，不是产品限制**。

原生流式方案：

| 平台 | API | 关键点 |
|---|---|---|
| Android | `android.graphics.pdf.PdfDocument` | 每页 `startPage()` → `drawBitmap()` → `finishPage()`，内存里只有一页 |
| iOS | `UIGraphicsPDFRenderer` / Core Graphics `CGPDFContext` | 边渲染边写 |
| 鸿蒙 | 自建 JPEG→PDF 写入器（`PdfWriter.ets`，已实现） | 直接嵌入 JPEG（DCTDecode），不重新编码；A4 等比缩放 |

接口建议（与 `DocumentEdgeDetector` 风格一致）：

```ts
export interface PdfWriter {
  readonly name: string;
  isAvailable(): boolean;
  /** 逐页写入；每页图片处理完即释放，内存与页数无关 */
  write(
    imageUris: string[],
    outputUri: string,
    options?: {
      pageWidth?: number;   // 595
      pageHeight?: number;  // 842
      maxDim?: number;
      quality?: number;
      onProgress?: (done: number, total: number) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ uri: string; pageCount: number }>;
}
```

### 6.1 鸿蒙实现（已落地）

`harmony/entry/src/main/ets/pdf/PdfWriter.ets` 不依赖 `@ohos.print`，直接写
PDF 字节流，思路最接近「原生流式」：

1. 逐页读取 JPEG，解析 SOF 段拿到宽高和分量数（`/DeviceRGB` 或 `/DeviceGray`）；
2. 图片作为 `/Subtype /Image` + `/Filter /DCTDecode` 的 XObject **原样嵌入**，
   不像 expo-print 那样先转 base64 再让 WebView 解码；
3. 页面内容流只有 `q / <w> 0 0 <h> <x> <y> cm /Im0 Do Q`，按 A4 等比居中；
4. 边写边记录对象偏移，最后写 `xref` + `trailer`。

内存里同时只有一页 JPEG（处理下一页时上一页已释放），页数只受磁盘限制。
鸿蒙端 `PdfPage.ets` 把上限设为 30 页，用的是保守值而不是技术限制。
字节布局已在宿主侧用 Node 镜像验证：2 页 PDF、8 条 xref 全部指向正确的
`N 0 obj`，`/Count` 与 `/MediaBox` 正确。

这套写入器同样可以作为 Android/iOS 的参考实现（C++ 版本可直接复用到
`modules/image-core/common/`）。

有了它之后：

- 页数上限从 50 提到「受磁盘限制」；
- 不再需要按页数降低分辨率；
- base64 完全不出现在 JS/WebView 里，低端机也稳定；
- 仍保留 expo-print 作为回退（Expo Go、未接原生模块的环境）。

---

## 7. 与现有页面模型的衔接

`PdfPage` 已经是「原图 + 派生图 + 编辑参数」的结构：

```ts
type PdfPage = {
  id: string;
  originalUri: string;   // 永不修改，作为所有编辑的源头
  uri: string;           // 当前用于生成 PDF 的图
  thumbUri: string;      // 220px 缩略图
  filter: FilterKey;
  rotation: Rotation;
  cropQuad?: DocumentQuad | null;  // 预留：四角
  annotations?: PageAnnotation[];  // 预留：批注
};
```

接入检测/切边时的写入规则：

| 操作 | 写入 |
|---|---|
| 仅检测 | `cropQuad`（`uri` 不变） |
| 应用切边 | `uri` = 新文件，`cropQuad` = 使用的四角 |
| 切边后再增强 | 以切边结果为输入跑滤镜，仍写 `uri`，`cropQuad` 保留 |
| 恢复原图 | `uri` = `originalUri`，`cropQuad` = `null`，`filter` = `original`，`rotation` = 0 |

批注建议**先渲染成位图再写入 `uri`**，而不是在 PDF 阶段叠加：这样 PDF 生成、
分享、后续编辑都只需要处理一张 JPEG，渲染逻辑也只实现一次。
`PageAnnotation` 里保存归一化坐标和文字，是为了让批注可再次编辑/删除。

---

## 8. 验证方案

在没有真机/模型的情况下，可先验证不依赖推理的部分：

1. **契约测试**：用假 detector（`setDocumentEdgeDetector`）注入固定四角，验证
   UI 能存 `cropQuad`、切边后 `uri` 改变而 `originalUri` 不变、恢复原图能回退。
2. **批量路径**：注入 200 个假 URI，确认 `detectDocumentBatch` 的结果顺序正确、
   `onProgress` 递增、abort 能及时停止。
3. **内存**：Android Studio Profiler 观察处理 1 张与 200 张时的 Java/native 峰值，
   两者应在同一量级（差异只来自缩略图与索引）。
4. **切边算法**：共享 C++ 的 `warpPerspective` 可在宿主侧用合成网格图做单测
   （已知四角 → 输出应为矩形网格），再与 OpenCV `getPerspectiveTransform` 对照。
5. **PDF 写入**：原生 writer 接入后，用同一批图片分别走 expo-print 与原生路径，
   对比页数、页面尺寸和像素差异。

---

## 9. 落地顺序建议

1. 共享 C++ 实现 `warpPerspective` + 宿主侧测试（不依赖模型）。
2. Android 接 ONNX Runtime（NNAPI EP），实现 `detect` / `warp`，注册 detector。
3. 单页编辑器把「✂ 切边」从提示改成「检测 → 预览四角 → 应用」。
4. 接 `detectBatch`，导入后后台批量检测，用户逐页确认。
5. 原生 `PdfWriter` 替换 expo-print，放开页数上限（鸿蒙端已完成，
   Android/iOS 仍走 expo-print）。
6. Android / iOS 按同一契约接入（共享 C++ 写入器可复用鸿蒙端的布局）。
