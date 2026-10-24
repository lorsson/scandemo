/**
 * Type definitions for libimage_core.so (NAPI bridge over the shared C++ kernel).
 *
 * 与 modules/image-core/src/ImageCoreModule.ts 的 NATIVE 接口、Android 的
 * ImageCoreModule.kt 外部函数、iOS 的 ImageCoreBridge.h 一一对应。
 */

/**
 * Pixel buffer contract: width*height little-endian uint32 values, each
 * 0xAARRGGBB. Request `BGRA_8888` from the HarmonyOS decoder so the memory
 * order (B,G,R,A) yields exactly that integer.
 */
export const processPixels: (
  buffer: ArrayBuffer,
  width: number,
  height: number,
  filter: number
) => number;

/** 带第二步微调：contrast/brightness -50..50，detail 0..100 */
export const processPixelsEx: (
  buffer: ArrayBuffer,
  width: number,
  height: number,
  filter: number,
  contrast: number,
  brightness: number,
  detail: number
) => number;

/** 四角透视裁剪的输出尺寸：[width, height] */
export const warpSize: (
  srcWidth: number,
  srcHeight: number,
  quad: Float64Array,
  maxDim: number
) => number[];

/** 把 src 里 quad（TL,TR,BR,BL，归一化）围成的四边形拉成 dst 矩形 */
export const warpPixels: (
  src: ArrayBuffer,
  srcWidth: number,
  srcHeight: number,
  dst: ArrayBuffer,
  dstWidth: number,
  dstHeight: number,
  quad: Float64Array
) => number;

export const resizeSize: (
  srcWidth: number,
  srcHeight: number,
  maxDim: number
) => number[];

export const resizePixels: (
  src: ArrayBuffer,
  srcWidth: number,
  srcHeight: number,
  dst: ArrayBuffer,
  dstWidth: number,
  dstHeight: number
) => number;

/** 顺时针旋转 90 / 180 / 270 */
export const rotatePixels: (
  src: ArrayBuffer,
  srcWidth: number,
  srcHeight: number,
  dst: ArrayBuffer,
  degrees: number
) => number;

export const version: () => string;
