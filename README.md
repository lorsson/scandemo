# 扫描 Demo（Expo + 共享 C++ 图像内核）

一个跨 Android / iOS / HarmonyOS 的文档扫描演示应用。UI 用 Expo / React Native
（鸿蒙端用 ArkWeb 承载 H5 界面），滤镜算法是一份纯 C++ 代码，分别通过
JNI、Objective-C++、Node-API 编译进三个平台。

> 设计细节、算法公式、像素契约和验证数据见 [docs/DESIGN.md](docs/DESIGN.md)。
> 鸿蒙工程的独立说明见 [harmony/README.md](harmony/README.md)。

---

## 1. 功能

- **拍照扫描**：调用后置相机拍摄文档，自动缩放到最长边 1400 px。
- **导入图片**：应用内相册选择器（参考扫描全能王）。
  - 缩略图网格，点选后右上角小圆圈标注「第几张」，按选择顺序排列；
  - 支持手指横向划选：一键划过一行即可批量选中/取消；
  - 已选图片可全屏预览、左右翻页、取消选择；
  - 一次可导入多张，选完直接进多页编辑器。
- **多页扫描文档**：导入后进入编辑器，可**继续添加图片**（同一选择器以浮层打开）、
  上下调整页序、逐页切换算法 / 旋转、裁剪、移除页面，最后一次性保存成一份文档。
- **导入编辑页**（按扫描全能王的方式组织，见 `ScanEditorScreen.tsx`）：
  - 顶栏左侧「返回」，中间是可编辑的 PDF 文档名（默认取第一张图片的文件名），
    右侧「分享」（生成整份 PDF 后直接拉起系统分享面板）；
  - 左右滑动或点页码两侧的 `◀` / `▶` 翻页；
  - 页码行右侧是「分割图标 + 原图 | 对比」胶囊按钮，按住显示原图，松手回到处理后的图；
  - 图片右上角 `✕` 弹出「删除此页 / 重拍此页 / 取消」，重拍会用新图原地替换该页；
  - 算法区是带实时效果缩略图的方块，点一次应用、再点同一个进入第二步；
  - 第二步可调对比度（-50..50）、亮度（-50..50）、细节（0..100），
    拖动时实时预览，`✓` 保存、`✕` 放弃；
  - 勾选「应用到所有页」后，算法和微调会作用到全部页面；
  - 底部工具：继续导入 / 左转 / 右转 / 裁剪 / 提取文字（OCR 占位），
    以及「保存所有图片」（全部页面逐张进系统相册）、「保存成 PDF」（整份
    文档生成后弹系统保存框选文件夹，文件名取顶栏的文档名）。
- **11 种算法**：原图 / 去阴影 / 去除手写 / 高清 / 增亮 / 增强锐化 / 省墨 /
  增强 / 灰度 / 黑白 / 反色。
  - 增强：亮部向白色提亮、暗部提高对比度，适合纸面文档。
  - 去阴影：按局部背景亮度做除法补偿；去除手写：按饱和度识别彩色笔迹并涂白。
  - 高清：1%/99% 分位拉伸 + 轻量反锐化；省墨：压缩墨量、保留可读性。
  - 灰度：亮度加权 + 轻微对比度拉伸；黑白：Otsu 自适应阈值二值化。
- **算法清单可配置**：`src/lib/filters.ts` 是唯一入口，增删一项即可调整界面
  列表、顺序和标签；C++ / Canvas 各补一份同名实现（见 DESIGN §15）。
- **四角透视裁剪**：未接入 ONNX 切边模型前，「智能裁剪」默认给出整图的
  左上 / 右上 / 右下 / 左下四个点；角点显示为圆圈、边的中点显示为沿边方向
  的长条。手指落在手柄附近即可抓住最近的手柄，拖动时显示放大镜：镜心与手柄
  保持固定偏移、不做任何夹取，所以和手指 1:1 同步、不会跳；放大镜允许超出
  图片边界，只有图片区域被放大，界外的部分是透明的（能看到下面的界面）。
  四个点围成的不是凸四边形时（边交叉或角凹陷），四条边变红并在底部提示
  「无效区域」，「确定」不可用。确认后按单应矩阵做透视校正，结果成为新的
  `originalUri`（旋转同时烘焙）。
  - 透视校正在共享 C++ 内核里完成（Android JNI / iOS C 桥），文件直接进、文件
    直接出；缩放与旋转同样走 C++，`expo-image-manipulator` 只在 Expo Go 里兜底。
- **示例文档**：不依赖相机，直接加载打包在应用内的测试图片。
- **旋转**：左转 / 右转 90°。
- **导出与历史**：扫描编辑器里的结果一次导出为相册图片或 PDF（不再写入应用内文档库）；
  历史扫描记录仍从 AsyncStorage 读取并按时间倒序展示，显示「N 页」和首页缩略图。
- **底部五个入口**：首页 / 全部文档 / 相机（中间凸起的主按钮）/ 工具箱 / 我的。
  全部文档把扫描与 PDF 混排并按时间排序；工具箱集中拍照、导入、转 PDF；
  我的展示本机数据量、算法引擎和版本。
- **详情与导出**：逐页查看多页文档（缩略图条切换），一次导出全部页到系统相册，删除。
- **图片转 PDF**：相册多选 → 逐页缩略图排版 → 上下调整顺序 →
  生成 A4 PDF → 系统分享。生成后仍可改顺序、增删、重新生成。
  - **页数上限按设备内存自适应**：2 GB 约 15 页、4 GB 约 35 页、8 GB 约 60 页，
    同时参考 Android JVM 堆大小；单页分辨率随页数从 1800 px 降到 1200 px。
- **三种算法模式（都可用）**：
  1. **自动**：导入前选好「导入时自动执行」的算法，每张导入图立即处理；
  2. **手动**：任意一页点 ✎ 单独选算法 / 旋转，只影响该页；
  3. **原图**：选「原图」则导入不改像素，也可一键「全部恢复原图」。
  - 导入后改主意，可点「对整个文档执行」把当前算法补应用到全部页面。
- **单页编辑（生成前后都可以）**：对任意一页做算法 / 旋转 / 微调，保存后回到
  排版页重新生成；原图始终保留，可一键恢复。「✎ 批注」仍为预留结构，
  见 [docs/EDGE_DETECTION.md](docs/EDGE_DETECTION.md)。
  - PDF 单页编辑器使用 `EditorScreen`（算法 + 旋转），导入编辑页使用
    `ScanEditorScreen`（完整算法库 + 微调 + 裁剪 + 批量应用）。
  - 唯一的例外是裁剪：它把结果烘焙成新的 `originalUri`，无法再还原到裁前原图。
- **双引擎**：有原生模块时滤镜与几何变换（裁剪 / 缩放 / 旋转 / 缩略图）全走
  C++，JS 侧只剩参数换算；Expo Go 等没有原生模块的环境自动退回
  WebView + Canvas 与 `expo-image-manipulator`，功能一致。

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 应用框架 | Expo SDK 58 / React Native 0.88 / React 19 |
| 语言 | TypeScript（UI）、Kotlin（Android 桥）、Swift（iOS 桥）、ArkTS（鸿蒙桥）、C++17（算法） |
| 原生模块 | Expo Modules API（`expo-module-gradle-plugin` + Swift Module） |
| 回退引擎 | `react-native-webview` + Canvas 2D |
| 图片处理 | 滤镜 + 裁剪 / 缩放 / 旋转：C++ 共享内核；`expo-image-manipulator`（Expo Go 兜底）、`expo-file-system`、`expo-asset` |
| 相机 / 相册 | `expo-camera`、`expo-image-picker`、`expo-media-library` |
| PDF | ImageCore 原生 `createPdf`（Android `PdfDocument` / iOS `UIGraphicsPDFRenderer`）、`expo-print` 兜底、`expo-sharing`（系统分享） |
| 存储 | `expo-file-system` + `@react-native-async-storage/async-storage` |
| 构建 | Expo CNG / Gradle / CocoaPods / hvigor |
| 桌面 | 同一份 C++ → 动态库（C ABI + JNI）+ 命令行工具，Python / Java / 任意 UI 框架调用 |

---

## 3. 目录结构

```
.
├── App.tsx                      # 路由状态机 + 文档增删改
├── index.ts                     # registerRootComponent
├── app.json                     # Expo 配置（名称、包名、权限、minSdk）
├── metro.config.js              # Windows 长路径 workaround（见 §8）
├── modules/image-core/          # 自定义原生模块
│   ├── common/
│   │   ├── image_core.h         # 共享 C++ 接口
│   │   └── image_core.cpp       # 滤镜算法（唯一实现）
│   ├── common/image_core_c.*    # 稳定 C ABI（桌面 / 任意 FFI）
│   ├── android/                 # Kotlin 桥 + JNI + CMake
│   ├── ios/                     # Swift 桥 + Objective-C++ + podspec
│   ├── desktop/                 # 桌面端：CMake、CLI、Python ctypes、Java JNI、自检
│   │   └── electron/            # 桌面界面：Electron 壳（spawn imagecore）
│   └── src/ImageCoreModule.ts   # JS 侧封装与可用性探测
├── src/
│   ├── screens/                 # Home / Docs / Tools / Profile / Camera /
│   │                            # PhotoPicker / ScanEditor / Editor / Document /
│   │                            # Pdf / PdfReader
│   ├── lib/
│   │   ├── filterNative.ts      # 原生路径
│   │   ├── filterEngine.tsx     # WebView Canvas 回退
│   │   ├── imagePipeline.ts     # 缩放 / 旋转 / 透视裁剪（原生优先）、base64、资源解析
│   │   ├── pageStore.ts         # 页面文件管理（导入/编辑/删除），扫描与 PDF 共用
│   │   ├── storage.ts           # 扫描文档索引 + 旧版单图记录迁移
│   │   ├── pdf.ts               # HTML 排版 → expo-print → PDF
│   │   ├── pdfLimits.ts         # 按设备内存计算页数上限 / 单页尺寸
│   │   ├── pdfStorage.ts        # PDF 项目目录、页面、缩略图、索引
│   │   ├── filterRunner.ts      # 原生 / Canvas 统一的单图滤镜入口
│   │   ├── pageRender.ts        # 从 originalUri 重渲染一页（旋转 + 滤镜）
│   │   ├── documentDetection.ts # ONNX 四角检测 / 切边（预留接口）
│   │   └── abort.ts             # 可取消任务的统一错误
│   ├── types.ts                 # FilterKey / DocPage / ScanDoc / PdfDoc / DocumentQuad
│   └── theme.ts
├── harmony/                     # OpenHarmony 工程（ArkTS + ArkWeb + NAPI）
├── assets/                      # 图标与示例文档
└── docs/
    ├── DESIGN.md                # 设计文档
    └── EDGE_DETECTION.md        # 切边接口、低内存批量处理、原生流式 PDF
```

`android/`、`ios/` 由 Expo CNG 生成，**不提交**，也不要手改；原生行为通过
`app.json` 和 config plugin 配置。

---

## 4. 环境要求

- Node.js 20+（CI 用 22）
- Android：JDK 17、Android SDK（platform-tools、build-tools、NDK、CMake 3.22.1）
- iOS：macOS + Xcode（本仓库通过 GitHub Actions 的 macOS runner 构建）
- 鸿蒙：DevEco 命令行工具 + OpenHarmony SDK（本机为 SDK 5.0.0.71 / API 12）

安装依赖：

```bash
npm install
# 新增 Expo/RN 依赖时必须用下面这条，自动选 SDK 兼容版本
npx expo install <package>
```

---

## 5. 运行

### 5.1 Expo Go（最快，无原生模块）

```bash
npx expo start
```

用 Expo Go 打开后，应用检测不到 `ImageCore` 原生模块，自动使用 WebView Canvas
回退。所有 UI 功能可用，日志里是 `[image-core:canvas] ...`。

> Expo Go 对文件系统做了沙盒限制：`expo-print` 的输出在宿主 App 的缓存目录，
> `expo-file-system` 无法直接复制。`generatePdf()` 检测到这种情况会自动改用
> 「让 expo-print 直接返回 base64，再由 JS 写入沙盒」，功能不受影响（会多打印
> 一次，日志里出现 `cannot copy print output ... retrying with base64`）。
> 开发/正式构建走正常的一步复制。

### 5.2 开发构建（走原生 C++ 模块）

```bash
npx expo run:android          # 本地编译并安装
npx expo run:ios              # 需要 macOS
```

或使用 EAS 云构建（首次需在项目根目录执行 `eas build:configure` 生成 `eas.json`）：

```bash
npx eas-cli@latest build --profile development --platform android
```

日志里应出现：

```
[image-core] enhance 1050x1400 decode=...ms process=...ms encode=...ms total=...ms
```

### 5.3 鸿蒙

见 [harmony/README.md](harmony/README.md)。摘要：

```bash
cd harmony
ohpm install
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

输出 `entry/build/default/outputs/default/entry-default-unsigned.hap`，未签名，
安装需要签名配置。

---

## 6. 使用流程

1. 首页三选一：拍照扫描 / 导入图片 / 示例文档。
2. 「导入图片」打开应用内相册：点缩略图选中，右上角圆圈显示选择顺序；
   也可以手指横向划过一行批量选中（从已选格子起手则整段取消）；
   点「预览」可全屏左右翻看已选图片，点「完成 (n)」进入编辑器。
3. 编辑器里逐张导入会立即按「增强」处理（单张失败保留原图），顶部显示进度；
   左右滑动或点 `◀` / `▶` 翻页；页码行右侧的「原图|对比」按住看原图；
   图片右上角 `✕` 可选「删除此页 / 重拍此页 / 取消」。
4. 点算法方块应用算法；再点同一个进入对比度 / 亮度 / 细节微调（✓ 保存、✕ 放弃）；
   勾选「应用到所有页」后对整份文档生效。
5. 点「裁剪」进入四角校正：默认整图四角，圆圈是角点、长条是边的中点；
   手指落在手柄附近就能抓住它（贴边的手柄也能按到，触摸区域比图片大一圈），
   拖动时放大镜跟手移动、只放大图片区域；四点围成非凸四边形时边框变红并
   提示无效区域。确定后按透视变换拉正，并自动重跑当前算法。
6. 想继续加图：点「继续导入」，同一个相册选择器以浮层打开，完成后追加到末尾；
   剩余可选数量按文档页数上限自动扣减。
7. 底部可直接「保存所有图片」（全部页面逐张写入系统相册，显示进度）或
   「保存成 PDF」：生成完弹系统保存框，选一个文件夹即可保存（文件名取顶栏
   的文档名，同名会覆盖）；保存成功后还可再分享。
8. 顶栏中间是 PDF 文档名，默认取第一张图片的文件名，点一下即可修改；
   生成 PDF、保存时的文件名都用它。顶栏右侧「分享」直接生成并拉起系统分享
   面板；左侧「返回」会提示丢弃本次草稿。
9. 点列表项进入详情，可逐页翻看、「导出 N 页到相册」或删除。

图片转 PDF：

1. 首页点「图片转 PDF」→ 直接进入排版页（此时还没有页面）。
2. 先在顶部选「导入时自动执行」的算法（默认增强）。这一步决定新图片是否
   自动处理、用什么算法；选「原图」就不处理。
3. 点「＋ 添加图片」→ 相册多选（数量受本机内存上限约束，按选择顺序排列）。
   导入时逐张缩放、应用算法、写盘、生成 220 px 缩略图，显示进度，可取消。
4. 用 ↑ ↓ 调整顺序，✎ 进入单页编辑（手动模式），✕ 移除页面。
5. 想改主意：换一个算法后点「对整个文档执行」，会把所有页面重做一遍；
   点「全部恢复原图」清空所有页面处理（旋转保留）。
6. 点「生成 PDF」；生成后再改顺序/页面，按钮会变成「重新生成 PDF」并提示旧文件
   已过期。
7. 生成完成后按钮变成「分享 PDF」，走系统分享（保存到文件、发邮件、打印等）。

> 页面模型始终是「原图 + 派生图 + 参数」：`originalUri` 永不覆盖，
> 批量应用和单页编辑都从它重渲染，所以重复执行算法不会累积画质损失。

---

## 7. 构建

### 7.1 Android Release

```bash
# android/ 不存在时先生成
npx expo prebuild --platform android

cd android
./gradlew assembleRelease --no-daemon
```

产物：`android/app/build/outputs/apk/release/app-release.apk`（全 ABI，约 97 MB）。

注意：模板默认 `release` 也用 **debug keystore** 签名，只适合内部安装测试；上架前
需要配置自己的 keystore。`minSdkVersion` 由 `app.json` 里的
`expo-build-properties` 固定为 28（Android 9）。

### 7.2 iOS 未签名 IPA

`.github/workflows/ios-unsigned-ipa.yml` 在 `macos-15` 上执行
`expo prebuild` → `pod install` → `xcodebuild`（关闭签名）→ 打包 `Payload/` 为
`.ipa`，作为 Actions artifact 上传。未签名 IPA 不能直接安装，需要用
Sideloadly / AltStore 配合免费 Apple ID 侧签（7 天有效）。

### 7.3 鸿蒙 HAP

同上，详见 [harmony/README.md](harmony/README.md)。

### 7.4 桌面端（Windows / macOS / Linux）

算法模块不依赖 React Native，可以直接编成桌面动态库和命令行工具：

```bash
cmake -S modules/image-core/desktop -B build/desktop -DCMAKE_BUILD_TYPE=Release
cmake --build build/desktop --parallel
ctest --test-dir build/desktop --output-on-failure
```

| 产物 | 用途 |
|---|---|
| `image_core.dll` / `libimage_core.dylib` / `.so` | C ABI（`ic_process_argb32` / `ic_process_rgba`）+ JNI，Python ctypes、Java、Qt/WinUI/SwiftUI 直接调用 |
| `imagecore` | 命令行：`imagecore -f enhance -q 90 -m 1600 in.jpg out.jpg` |
| `imagecore-drop.cmd` | Windows 用：把图片拖到它上面即可（`imagecore` 直接双击只会打印用法） |
| `image_core_selftest` | 22 项自检，`ctest` 自动运行 |

Python（仅标准库）与 Java 的绑定、构建细节见
[modules/image-core/desktop/README.md](modules/image-core/desktop/README.md)。
CI 在 `ubuntu-latest` / `macos-latest` / `windows-latest` 三平台编译并跑
C++、CLI、Python、Java 四组测试：
[.github/workflows/desktop-image-core.yml](.github/workflows/desktop-image-core.yml)。

#### 桌面界面：Electron

[modules/image-core/desktop/electron/](modules/image-core/desktop/electron/)
是一个可以双击运行的界面：拖拽打开图片、四个滤镜切换、质量 / 最长边、
按住看原图、另存为。它不依赖原生 Node 模块，处理时 `spawn` 上面那个
`imagecore` 命令行，所以算法仍然只有 `common/image_core.cpp` 一份。

```bash
cd modules/image-core/desktop/electron
npm install
npm start                 # 开发模式（需要已构建 build/desktop*）
npm run package           # 打包成 dist/Scan Demo-<platform>-<arch>/Scan Demo.exe
```

打包时会把 `imagecore` 和动态库放进 `resources/`，目标机器不用装 C++ 运行库、
不用装 Node。手机端仍然是 Expo：Expo 只支持 Android / iOS / Web，
`react-native-macos` / `react-native-windows` 还落后 RN 0.88，所以桌面 UI 单独做壳。

---

## 8. Windows 长路径与构建缓存（重要）

本机开发时遇到过三个只在 Windows 出现的问题，已通过环境配置绕过：

1. **MAX_PATH 260**：CMake 会把源码绝对路径镜像进对象目录，
   `react-native-safe-area-context` 的原路径会超过 260 字符。解决方式是把该包实体
   放到 `D:\n\sacontext`，`node_modules/react-native-safe-area-context` 用目录
   junction 指过去；`metro.config.js` 里为此包加了 `watchFolders` 和
   `resolver.nodeModulesPaths`。没有这个 junction 的机器会走默认配置。
2. **autolinking 缓存**：React Native 按 `package.json` / lockfile 的哈希缓存
   `autolinking.json`。移动包目录后必须删除
   `android/build/generated/autolinking` 与 `android/app/.cxx`，否则 CMake 会一直
   引用旧路径。
   - ⚠️ **每次 `npm install` / `npx expo install` 都会把 junction 换回真实目录**，
     之后必须重建，否则 CMake 又会因长路径失败（`mkdir ... No such file or
     directory`）：
     ```bash
     rm -rf node_modules/react-native-safe-area-context
     node -e "require('fs').symlinkSync('D:/n/sacontext','node_modules/react-native-safe-area-context','junction')"
     rm -rf android/build/generated/autolinking android/app/.cxx
     ```
3. **不要用 `subst` 盘符构建**：项目在 `X:`、某个依赖在 `D:` 时，Gradle codegen
   会报 `this and base files have different roots`。清掉 subst，从真实路径构建。

---

## 9. 配置与定制

| 需求 | 修改位置 |
|---|---|
| 桌面显示名称（当前为 `myapp`） | `app.json` → `expo.name`，重新 prebuild / 打包 |
| 包名 / Bundle ID | `app.json` → `expo.android.package`、`expo.ios.bundleIdentifier` |
| 最低 Android 版本 | `app.json` → `expo-build-properties.android.minSdkVersion` |
| 相机/相册权限文案 | `app.json` → `plugins` 中 `expo-camera`、`expo-image-picker`、`expo-media-library` |
| 示例文档 | `assets/sample_doc.jpg`（原生） / `harmony/.../rawfile/sample.jpg`（鸿蒙） |
| 预览尺寸 | `src/lib/imagePipeline.ts` 的 `prepareBase(uri, 1400)` |
| JPEG 质量 | 滤镜：`src/lib/filterNative.ts` 的 `92`；裁剪：`src/lib/imagePipeline.ts` 的 `warpPerspective`；Canvas：`filterEngine.tsx` 的 `0.9` |
| PDF 页数上限 | `src/lib/pdfLimits.ts` 的 `memoryTier()` / `heapCap()`（按设备内存 15–60 页） |
| PDF 单页分辨率 | `src/lib/pdf.ts` 的 `pdfProfileFor()`（按页数 1800/1500/1200 px，再受内存上限约束） |
| PDF 默认算法 | 新建文档时为 `enhance`（`App.tsx`）；用户可在排版页改，存于 `PdfDoc.defaultFilter` |
| 页面缩略图宽度 | `src/lib/pageStore.ts` 的 `THUMB_WIDTH`（220 px，扫描与 PDF 共用） |
| 扫描页尺寸 / 质量 | `src/lib/storage.ts` 的 `SCAN_MAX_DIM`（1400 px） / `SCAN_JPEG_QUALITY`（0.92） |
| 导入图片单次上限 | 用 `src/lib/pdfLimits.ts` 的 `getPdfLimits().pageLimit`（同一套内存分档） |
| 鸿蒙 PDF 页数 / 尺寸 | `harmony/.../pages/PdfPage.ets` 的 `MAX_PAGES`（30）、`PAGE_MAX_DIM`（1600 px） |
| 新增滤镜 | 见 [docs/DESIGN.md](docs/DESIGN.md) §15 |

---

## 10. 检查与验证

提交前必须通过：

```bash
npx tsc --noEmit
npx expo lint
```

可选：

```bash
npx expo-doctor
npx expo install --fix
```

本机另外维护了四套不在仓库内的宿主侧验证脚本（路径仅适用于开发机）：

- `D:\tools-src\wsl\lib\webview_test\run_webview_tests.js`：抽取真实 WebView HTML，
  在 headless Edge（Chromium）里跑 20 项断言。
- `D:\tools-src\wsl\lib\harmony_napi_test`：把 `napi_init.cpp` 编成 Node-API 插件，
  跑 10 项断言 + 12 MP 计时。
- `D:\tools-src\wsl\lib\apple_host_test`：把 `ImageCoreBridge.mm` 编到 Linux，
  跑 16 项断言。
- `D:\tools-src\wsl\lib\cross_contract_check.js`：44 项跨端契约检查。

结果摘要（详见设计文档 §13）：

| 验证 | 结果 |
|---|---|
| WebView 引擎 | 20/20 通过，单滤镜 1200×1600 约 10 ms（宿主） |
| 原生 vs Canvas 像素 | gray 最大差 2；bw 99.995% 一致；enhance 99.78% 在 ±1 内 |
| Android release APK | 模拟器验证示例文档 → 三种滤镜 → 保存；1050×1400：增强 379 ms / 灰度 93 ms / 黑白 86 ms |
| 原生几何（裁剪 / 旋转） | 模拟器 debug APK：示例文档 → 拖动角点 → 确定（C++ 透视校正 1050×1400，total 284 ms）→ 右转 / 左转（C++ 旋转，total 118 ms）；Expo Go 同操作走 Canvas，裁剪约 5.6 s |
| 图片转 PDF | 模拟器 debug APK：导入 3 页 → 排序 → 生成 → 单页灰度 → 重新生成 → 分享；PDF 实测 1/3 页、A4 |
| Expo Go PDF | 沙盒复制失败后自动改走 base64，生成成功 |
| 自动算法 / 批量应用 | 模拟器 debug APK 通过：导入 2 张即按「增强」自动处理；单页改「黑白」保存后缩略图与标签同步；「对整个文档执行」弹覆盖提示后可批量改回；重启后 2 页 / 增强 状态保留 |
| 页数自适应 | 模拟器实测 1.5 GB RAM / 384 MB 堆 → 页脚显示「单次最多 15 页」；该文档 2 页 PDF 生成成功且为 A4 |
| 多页扫描 / 应用内选择器 | 模拟器 debug APK：相册选中 2 张（圆圈 1、2）→ 预览左右翻页 → 完成 → 编辑器 2 页（增强）；「＋ 添加图片」浮层再选 1 张 → 追加为第 3 页；第 3 页切灰度、上移、删除第 2 页 |
| 编辑页顶栏 / 导出 | 模拟器 debug APK：标题默认取首图文件名（`s26`）→ 改成 `Test_Doc` → 分享拉起系统 CHOOSER → 保存所有图片（相册 +1）→ 保存成 PDF（SAF 选 Downloads，得到 `Test_Doc.pdf`，`%PDF-1.4`）→ 返回弹放弃确认 |
| 鸿蒙 PDF | HAP `BUILD SUCCESSFUL`（API 12）；`PdfWriter.ets` 本体经 `tsc --strict` 编译 + `fileIo` 桩在宿主运行，1/2 页各 13/13 字节校验通过（xref 8/8、嵌入 JPEG 与源文件逐字节一致），`pdf-lib` 独立解析为 2 页 A4；未在真机/模拟器运行（本机无 DevEco 与模拟器镜像） |
| 桌面共享算法 | Windows（MinGW-w64 16.2 + CMake 4.4）与 Linux（GCC 11 + CMake 3.22）：`ctest` 22/22、CLI 四滤镜 + JPEG/PNG/BMP/TGA、Python ctypes 13/13、Java JNI 16/16；DLL 只依赖 `KERNEL32` + UCRT |
| iOS / 鸿蒙 | 桥接层宿主侧通过；App 未在真机运行 |

---

## 11. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| Expo Go 里滤镜慢但可用 | 正常，Expo Go 没有自定义原生模块，走 Canvas 回退 |
| Metro 卡在 `Loading from 10.0.2.2:8081...` 几十秒不动 | 宿主到 8081 的代理/防火墙会把响应卡在 65536 字节（带 `Accept-Encoding: gzip` 时必现）。换一个端口重启 `npx expo start --port 8082`，再把 `debug_http_host` 改成 `10.0.2.2:8082`（见下）即可 |
| 改了 JS 但设备还在跑旧逻辑 | Fast Refresh 在 bridgeless 模式下偶尔丢更新：`adb shell am force-stop <包名>` 后重启 App，或用 `r` 键让 Metro 重新下发整个 bundle |
| 开发构建里仍是 `[image-core:canvas]` | 原生模块没链上：确认 `modules/image-core` 在项目中、重新 `prebuild`；`imageCoreLoadError()` 可打印加载错误 |
| `requireNativeModule('ImageCore')` 抛错 | Expo Go 或未重新编译原生工程；执行 `npx expo run:android` 或 EAS development build |
| 示例文档报「图片读取失败」 | 独立安装包里静态图片是 drawable 资源，`resolveBundledAsset` 已处理；若仍失败看 `[image-core] 资源提取失败` 日志 |
| Gradle 报 CMake `mkdir ... No such file or directory` | 路径超过 260 字符或 autolinking 缓存过期，见 §8 |
| Gradle 报 `different roots` | 不要从 `subst` 盘符构建，见 §8 |
| 模拟器拍照失败 | 模拟器可能没有可用相机，改用「导入图片」或「示例文档」 |
| 应用内相册显示「没有相册访问权限」 | 系统设置里给 App 开「照片/媒体」权限；Android 13+ 只需「照片和视频」 |
| 生成 PDF 报 `Location ... isn't readable` | Expo Go 的沙盒限制；当前版本会自动重试 base64 路径，若仍失败请用开发/正式构建 |
| 生成 PDF 后页数不对 | `expo-print` 的 `numberOfPages` 是估算值（按 WebView 内容高度除页高），以实际打开的文件为准 |
| 分享 PDF 按钮不可点 | 改了顺序/页面后旧 PDF 已过期，先点「重新生成 PDF」 |
| 鸿蒙 HAP 装不上 | HAP 未签名，需要 DevEco 自动签名或手动证书 |

切换开发服务器地址（上面「Metro 卡住」的收尾步骤），debug 构建下可以不改代码：

```bash
printf '%s' '<map><string name="debug_http_host">10.0.2.2:8082</string></map>' > prefs.xml
adb push prefs.xml /data/local/tmp/prefs.xml
MSYS_NO_PATHCONV=1 adb shell "run-as com.example.scandemo \
  sh -c 'cat /data/local/tmp/prefs.xml > shared_prefs/com.example.scandemo_preferences.xml'"
adb shell am force-stop com.example.scandemo
adb shell am start -n com.example.scandemo/.MainActivity
```

---

## 12. 已知限制

- 文档边缘检测 / 透视切边只有接口和数据结构，**没有模型和原生实现**；拍摄时
  仍需自己对准。手动批注同理（字段已预留，渲染层未实现）。
- 没有 OCR、没有云同步；数据只在本机沙盒。11 种算法（去阴影 / 去除手写 /
  高清 / 增亮 / 锐化 / 省墨 / 增强 / 灰度 / 黑白 / 反色 + 原图）都已实现，
  全部在共享 C++ 内核里。
- PDF 页数仍有上限（按内存 15–60 页）：`expo-print` 需要把整份 HTML（含全部
  base64）放进内存。要彻底放开得改用原生流式 PDF 写入，方案见
  [docs/EDGE_DETECTION.md](docs/EDGE_DETECTION.md) §6；鸿蒙端已经用
  `PdfWriter` 实现了这条路径（JPEG 直接嵌入，不经过 base64）。
- 导入图片的页数上限沿用 PDF 的内存分档（2 GB 约 15 页），没有做转页/分卷；
  扫描编辑器与「图片转 PDF」都能导出 PDF，前者不保存文档记录。
- 索引写入不是事务性的：极端情况下文件已写、索引失败会留下孤儿图片。
- UI 路由是 `App.tsx` 里的状态机，不是 Expo Router（见设计文档 §14 ADR-6）。
- iOS 与鸿蒙只在宿主侧验证了桥接与算法，未在真机运行。
- Release APK 使用 debug keystore，不能上架。

---

## 13. 文档

- [设计文档](docs/DESIGN.md)：架构、像素契约、算法、时序、性能、构建与测试。
- [切边与批量处理](docs/EDGE_DETECTION.md)：ONNX 四角检测/透视切边的接口约定、
  低内存设备上的批量策略、原生流式 PDF 写入。
- [鸿蒙说明](harmony/README.md)：工程布局、NAPI 构建、SDK 注意事项。
- [AGENTS.md](AGENTS.md)：Expo 版本相关的开发约定（给 AI/新同事）。
