# HarmonyOS target (ArkTS + ArkWeb + shared C++ core)

Separate HarmonyOS (Stage model) project that reuses the same pure-C++ kernel
as Android/iOS:

```
modules/image-core/common/image_core.{h,cpp}   <-- shared, no platform deps
        ^                         ^
        | JNI                     | NAPI
android/.../jni_bridge.cpp   harmony/entry/src/main/cpp/napi_init.cpp
```

HarmonyOS NEXT has no AOSP layer and React Native / Expo cannot run there
natively, so the UI is H5 inside **ArkWeb** while the algorithm stays **C++**
(bound through NAPI).

## Layout

```
harmony/
  AppScope/app.json5
  build-profile.json5            # runtimeOS OpenHarmony, compatibleSdkVersion 12
  hvigorfile.ts / oh-package.json5 / hvigor/hvigor-config.json5
  entry/
    build-profile.json5          # externalNativeOptions -> src/main/cpp/CMakeLists.txt
    hvigorfile.ts / oh-package.json5
    src/main/module.json5
    src/main/ets/
      entryability/EntryAbility.ets
      pages/Index.ets            # <Web> + javaScriptProxy bridge (all ops)
      pages/PdfPage.ets          # native PDF composer (picker, filters, reorder)
      pdf/PdfWriter.ets          # JPEG -> PDF (DCTDecode, A4) writer
      pdf/PdfSave.ets            # PdfWriter + DocumentViewPicker.save()
      image/ImageCoreService.ets # PixelMap decode/encode + NAPI calls
    src/main/cpp/
      CMakeLists.txt             # builds libimage_core.so from common/ + napi_init.cpp
      napi_init.cpp              # 8 exports (see below)
      types/libimage_core/       # .d.ts + oh-package.json5 for the .so
    src/main/resources/
      rawfile/index.html         # scan editor UI (same layout/interactions as RN)
      rawfile/sample.jpg         # test image (copied to cache at startup)
```

## Native surface (NAPI)

`napi_init.cpp` exports exactly the same geometry/algorithms as the Android
JNI bridge; nothing platform-specific is reimplemented in ArkTS:

| export | meaning |
| --- | --- |
| `version()` | `image-core/0.3.0` |
| `processPixels(buf,w,h,filter)` | in-place filter, 11 ids |
| `processPixelsEx(buf,w,h,filter,c,b,d)` | filter + contrast/brightness/detail |
| `warpSize(w,h,quad,maxDim)` | output size for perspective crop |
| `warpPixels(src,sw,sh,dst,dw,dh,quad)` | bilinear perspective warp |
| `resizeSize(w,h,maxDim)` / `resizePixels(...)` | downscale (never upscale) |
| `rotatePixels(src,w,h,dst,degrees)` | 90 / 180 / 270 clockwise |

## Pixel format contract

`processPixels` expects an `ArrayBuffer` of `width*height*4` bytes where each
little-endian `uint32` is `0xAARRGGBB`. The ArkTS side asks the decoder for
`BGRA_8888`, whose memory order (B,G,R,A) yields exactly that integer on
little-endian cores — the same contract the Android `Bitmap.getPixels` and iOS
`premultipliedFirst | byteOrder32Little` paths use.

## H5 scan editor and bridge protocol

`rawfile/index.html` is a self-contained editor that mirrors
`src/screens/ScanEditorScreen.tsx` (same 11 filters, same adjust/preview
thresholds, same crop constants, same copy). It talks to ArkTS through
`javaScriptProxy`:

```
H5  nativeBridge.dispatch(JSON)  ->  Index.ets NativeBridge (serial queue)
                                        -> ImageCoreService (decode / C++ / encode)
    window.__onNativeResult(JSON) <-  controller.runJavaScript(...)
```

- Every request has an `id`; H5 keeps a pending map and a timeout, so
  concurrent taps cannot interleave decodes. Requests are executed one at a
  time (`this.ready = this.ready.then(...)`).
- Thousands of result bytes (data URLs, page lists) cannot be returned from a
  `javaScriptProxy` method reliably, hence the `runJavaScript` callback.
- The proxy is synchronous and has no file access, so every op is a **command**
  (`sample`, `pick`, `base`, `render`, `thumbs`, `warp`, `detect`, `ocr`,
  `read`, `delete`, `pdf`, `saveImages`, `version`), never a shared-memory
  buffer.
- Only the visible page asks for image data (`withData`); other pages get file
  paths and are rendered when activated. Images are displayed as data URLs
  because `file://` access inside ArkWeb is not reliable for cache paths.

## Edge detection (server-backed)

Same reason: no on-device corner model on HarmonyOS. With a server URL
configured (the toolbar's 识别服务 panel), the H5 editor:

- after import or camera capture (`autoCropPage`), posts the page to
  `/api/edgeDetector` and, if a usable quad comes back, warps it immediately;
- when crop is opened (`prefillCropQuad`), asks once more and pre-fills the four
  corners instead of starting from the full frame;
- without a server URL both steps are skipped silently and the crop starts
  from the full quad.

The response shape is the RN one (`src/lib/detectionServer.ts`):
`{code:200, data:{points: [[x,y]×4]}}` in uploaded-image pixels; the H5 runs
the same convexity/area check (`isUsableDetectedQuad`) and treats a full-frame
fallback as "not detected". `Index.ets` uploads at most 1280 px and gives the
server 4 s (`detectOnServer`); any failure returns `null` so the crop falls
back to manual dragging.

## OCR (server-backed)

HarmonyOS has no on-device OCR model, so the H5 toolbar's **提取文字** button calls
the detection server's `/api/ocr` — the same contract the RN app uses in
`src/lib/ocrServer.ts`, and the same server already configured for edge
detection (`localStorage` key `scan.detection.serverUrl.v1`).

```
H5 runOcr()                      (index.html)
  -> call('ocr', {input, serverUrl}, 90s)
  -> Index.ets NativeBridge.ocrOnServer()
       -> ImageCoreService.resizeFile(input, <cache>/ocr-*.jpg, 1600, 90)
       -> fileBase64 -> POST <serverUrl>/api/ocr {"image": base64}   (readTimeout 60s)
       -> readingText(): group boxes into rows, left-to-right inside a row
  -> {text}  ->  result panel (#ocrPanel), with 复制 / 完成
```

- Request/response are the RN ones: `{code:200, data:{width, height, lines:
  [{points: [[x,y]×4], text, score}]}}`, `points` in uploaded-image pixels.
- Rows are grouped by vertical centre with `tolerance = max(0.008, median line
  height × 0.6)`; the rest of `readingText` mirrors `src/lib/ocr.ts`.
- No server URL → the H5 opens the server panel and asks the user to configure
  one; network/HTTP/parse errors are surfaced as 识别失败 rather than "no text".
- The upload is the current page's preview (filtered) image, re-encoded as
  JPEG q90 with the long side capped at 1600 px; the temp file is deleted in
  `finally`.

## PDF feature

There are two entries: the H5 editor's **保存成 PDF** (exports the pages being
edited) and the floating **批量转 PDF** button that opens the native
`PdfPage` (registered in `main_pages.json`). Both end in
`pdf/PdfSave.ets`, which writes into cache and hands the file to
`DocumentViewPicker.save()` so the user chooses the destination.

```
PhotoViewPicker (multi-select)
  -> copy each picked URI into cacheDir/pdf-work/src-*
  -> ImageCoreService.processFile(..., maxDim=1600)   # decode downscale + shared C++ filter
  -> 1600 px JPEG preview + 220 px thumbnail
  -> reorder / per-page filter cycling / "apply to all"
  -> PdfWriter.write(paths, document.pdf)             # JPEG bytes embedded via /DCTDecode
  -> DocumentViewPicker.save()                        # user chooses the destination
```

Behaviour matches the RN app's three modes:

1. **自动**：顶部选择「导入时自动执行」的算法，新导入的每张图立即处理；
2. **手动**：每行的「滤镜」按钮在原图 / 增强 / 灰度 / 黑白之间循环，只改这一页；
3. **原图**：选「原图」可让新导入不处理，或点「全部恢复原图」清掉已有处理。

Implementation notes:

- Pages are rendered **sequentially**, so peak memory is one decoded image, not
  one per page (12 MP BGRA would be ~48 MB each). The decoder is asked for a
  1600 px `desiredSize` instead of decoding full size and shrinking later.
- `PdfWriter` never re-encodes JPEG data: it parses SOF for width/height and
  embeds the bytes as a `/DCTDecode` XObject. Memory during write is one page's
  JPEG. A4 is 595×842 pt; images are fitted and centred.
- The writer's byte layout (object numbering, xref offsets, `/Length`) was
  validated on the host by mirroring it in Node and checking every xref entry
  against the actual object offset (2-page PDF, all 8 entries valid).
- No storage permission is needed: both pickers use the system security UI.
  A copy of the generated PDF stays in `cacheDir/pdf-work/` if the user
  cancels the save dialog.

## Build (command line)

Requires the HarmonyOS/OpenHarmony SDK plus hvigor + ohpm. In this workspace the
toolchain lives at `D:\tools-src\harmonyos\cmdline` and the SDK is pointed to by
`DEVECO_SDK_HOME` / `HOS_SDK_HOME`.

```bash
# from this directory, with <cli> = the extracted command-line-tools root
ohpm install
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
# output: entry/build/default/outputs/default/entry-default-unsigned.hap
```

On Windows use `ohpm.bat` / `hvigorw.bat` (both need `node` on PATH).

## Status

- **Build verified** with OpenHarmony SDK 5.0.0.71 (API 12) + hvigor 5.16.2:
  `BUILD SUCCESSFUL` (53 s), output
  `entry/build/default/outputs/default/entry-default-unsigned.hap`, after the
  full scan editor and the 8-function NAPI surface were added (ArkTS strict
  mode passes; earlier builds covered `PdfPage.ets` / `PdfWriter.ets`). The
  later build that added the server-backed `ocr` op is also
  `BUILD SUCCESSFUL` (incremental), and the H5 suite now runs 67 checks
  (OCR panel: no-server prompt, request payload, result text, failure toast).
- HAP contains `libs/arm64-v8a/libimage_core.so` (stripped, 10 KB) plus
  `resources/rawfile/{index.html,sample.jpg}` and `ets/modules.abc`.
- The `.so` is ELF64 AArch64 and exports `RegisterImageCoreModule`; the NAPI
  module name is `image_core`, matching `import ... from 'libimage_core.so'`.
- Not yet run on hardware, and the HAP is **unsigned** — installing needs a
  signing profile (DevEco automatic signing with a Huawei ID, or manual
  `.p12`/`.cer`/`.p7b`).

### Local toolchain (this machine)

- CLI tools: `D:\tools-src\harmonyos\cmdline` (hvigor/ohpm; PATH entries added)
- SDK: `D:\tools-src\harmonyos\sdk` (component layout `sdk\12\{ets,js,native,previewer,toolchains}`)
- `local.properties`: `sdk.dir=D:\\tools-src\\harmonyos\\sdk`
- `hvigor/hvigor-config.json5` sets `hvigor.dependency.useNpm = true` so hvigor
  reuses the bundled plugin instead of downloading pnpm/plugins.

### SDK caveat

The anonymously downloadable SDK is **OpenHarmony** (Huawei Cloud mirror,
`repo.huaweicloud.com/harmonyos/os/5.0.0-Release/`). HarmonyOS NEXT's own SDK is
behind a Huawei ID download. This project therefore builds for the OpenHarmony
runtime (`runtimeOS: "OpenHarmony"`, `compileSdkVersion: 12`); the ArkTS/C++
code is the same either way.

### Build command actually used

```bat
ohpm install
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

## Verification without a device

HarmonyOS has no emulator on this host (the local emulator needs 16 GB RAM and a
real-name-verified Huawei ID), so the bridge was verified on the host:

`D:\tools-src\wsl\lib\harmony_napi_test`
- builds the **exact** `napi_init.cpp` + `image_core.cpp` against Node-API
  (the OpenHarmony NAPI ABI is Node-API) into `image_core.node`;
- `node test.js` runs 10 checks: version, argument validation, exact gray
  curve, Otsu binarization, enhance, alpha preservation, tail-canary bounds,
  plus 12 MP timings.

`D:\tools-src\wsl\lib\apple_host_test`
- compiles `ImageCoreBridge.mm` (pure C++, no Objective-C) with the shared core
  and runs 35 checks on the host: filter curves, alpha, `processPixelsEx`,
  warp size/pixel-exact full-quad copy, resize size/no-upscale, rotate
  90/180/270, and argument validation.

`D:\tools-src\wsl\lib\cross_contract_check.js`
- asserts all bindings agree on filter ids, pixel layout, result fields and
  module/function names (44 checks).

`D:\tools-src\wsl\lib\webview_test`
- extracts the real page HTML from `src/lib/filterEngine.tsx` and
  `harmony/.../rawfile/index.html`, mocks the WebView bridge, and drives both in
  headless Edge (Chromium — the same engine family as Android WebView/ArkWeb).
- engine page (11 checks): ready handshake, data-URL output, 1200x1600
  dimensions preserved, grayscale ratio 1.0, binary ratio 1.0 before JPEG
  encode, near-binary 0.9993 after JPEG, enhance changes pixels, ~10 ms per
  filter.
- H5 editor (52 checks) against a mock `nativeBridge` that answers every op:
  boot/sample, 11 filter tiles with thumbnails, filter press payloads, adjust
  preview (`maxDim 900`, `quality 85`) then full-size confirm, temp-file
  deletion, rotation (`base.rotation`), crop from the full quad, synthetic
  pointer drag moving the corner, loupe visibility/side, `warp` with 8
  normalized coordinates at quality 92 / maxDim 1600, source replacement,
  old-file cleanup, non-convex drag turning the polygon red with `确定` disabled,
  reset/cancel, append pick, PDF export collecting one preview path per page,
  native failure surfacing as a toast, and page deletion purging both files.
  The mock returns a real 1050×1400 canvas JPEG so `naturalWidth`/layout and
  pointer hit-testing run on realistic geometry.

`D:\tools-src\wsl\lib\webview_test\dump_compare_data.js` + `compare_native.js`
- feeds the **exact same RGBA pixels** (600x800 lossless PNG) to the Canvas
  engine and to the C++ kernel (`image_core.node`), then compares the canvas
  output *before* JPEG encoding against the kernel output:
  gray max Δ2 / mean 1.26, bw 99.995% identical (25 px flipped at the Otsu
  boundary), enhance 99.78% within ±1 (pixels near the `luma > 165` branch
  boundary diverge, max Δ24), alpha 0 mismatches.
- same-machine loop time (480k px): C++ 1.77/1.88/3.63 ms vs Canvas
  3.2/5.0/5.8 ms for gray/bw/enhance.

### PdfWriter on the host (`D:\tools-src\wsl\lib\harmony_pdfwriter_test`)

`PdfWriter.ets` depends only on `fileIo`, so the **actual source file** (copied
as `.ts`, import path swapped) is compiled with `tsc --strict` and run in Node
against a `fileIo` shim backed by `fs`. No hand-written mirror involved.

- 1-page and 2-page PDFs from the real `assets/sample_doc.jpg`;
- 13/13 byte checks each: header, `startxref` target, 20-byte xref entries all
  resolving to `N 0 obj`, `/Size` vs xref, `/Root`, `/Count`, `/Kids` token
  count, A4 `MediaBox` per page, exact content `/Length`, one embedded JPEG per
  page, embedded bytes **identical** to the source JPEG, image width/height;
- independent third-party parse with `pdf-lib`: 2 pages, 595.00×842.00, each
  page has `/Im0` 1200×1600.

What host testing cannot cover: the ArkTS `@ohos.multimedia.image` runtime, the
`<Web>`/`javaScriptProxy` bridge, the photo/document pickers, and any
UIKit/CoreGraphics behaviour in the iOS Swift layer.

### Emulator status

`hdc list targets` is empty and DevEco Studio is not installed. The official
HarmonyOS emulator is only distributed through DevEco Studio 5.x and its images
need a real-name-verified Huawei ID (login-gated, so it cannot be installed
unattended); the machine also has 8 GB RAM, below the emulator's 16 GB
requirement. The winget package `Huawei.DevEco` is DevEco 3.1 (API 9) and
cannot run this API 12 HAP. Running the HAP therefore still requires a real
HarmonyOS device or a DevEco-equipped machine.

