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
      pages/Index.ets            # <Web> + javaScriptProxy bridge + PDF entry
      pages/PdfPage.ets          # native PDF composer (picker, filters, reorder)
      pdf/PdfWriter.ets          # JPEG -> PDF (DCTDecode, A4) writer
      image/ImageCoreService.ets # @ohos.multimedia.image decode/encode + NAPI call
    src/main/cpp/
      CMakeLists.txt             # builds libimage_core.so from common/ + napi_init.cpp
      napi_init.cpp              # exports version(), processPixels(buf,w,h,filter)
      types/libimage_core/       # .d.ts + oh-package.json5 for the .so
    src/main/resources/
      rawfile/index.html         # H5 UI
      rawfile/sample.jpg         # test image (copied to cache at startup)
```

## Pixel format contract

`processPixels` expects an `ArrayBuffer` of `width*height*4` bytes where each
little-endian `uint32` is `0xAARRGGBB`. The ArkTS side asks the decoder for
`BGRA_8888`, whose memory order (B,G,R,A) yields exactly that integer on
little-endian cores — the same contract the Android `Bitmap.getPixels` path uses.

## PDF feature

The H5 page keeps the filter demo; a floating **图片转 PDF** button opens the
native `PdfPage` (registered in `main_pages.json`).

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
  `BUILD SUCCESSFUL`, output
  `entry/build/default/outputs/default/entry-default-unsigned.hap` (checked
  again after adding `PdfPage.ets` / `PdfWriter.ets`, including the new
  `ImageCoreService.processFile(maxDim)` and `makeThumbnail`).
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
  and runs 16 checks on the host.

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
  filter; plus H5 page (9 checks): button set, JSON payload fields
  (`id/input/output/filter/quality`), result and error rendering.

`D:\tools-src\wsl\lib\webview_test\dump_compare_data.js` + `compare_native.js`
- feeds the **exact same RGBA pixels** (600x800 lossless PNG) to the Canvas
  engine and to the C++ kernel (`image_core.node`), then compares the canvas
  output *before* JPEG encoding against the kernel output:
  gray max Δ2 / mean 1.26, bw 99.995% identical (25 px flipped at the Otsu
  boundary), enhance 99.78% within ±1 (pixels near the `luma > 165` branch
  boundary diverge, max Δ24), alpha 0 mismatches.
- same-machine loop time (480k px): C++ 1.77/1.88/3.63 ms vs Canvas
  3.2/5.0/5.8 ms for gray/bw/enhance.

What host testing cannot cover: the ArkTS `@ohos.multimedia.image` runtime, the
`<Web>`/`javaScriptProxy` bridge, and any UIKit/CoreGraphics behaviour in the
iOS Swift layer.

