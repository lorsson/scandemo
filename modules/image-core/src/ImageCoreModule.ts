import { requireNativeModule } from 'expo-modules-core';

export type NativeFilterKey =
  | 'original'
  | 'shadow'
  | 'dehand'
  | 'hd'
  | 'brighten'
  | 'sharpen'
  | 'inksave'
  | 'enhance'
  | 'gray'
  | 'bw'
  | 'invert';

export type NativeAdjust = {
  contrast: number;
  brightness: number;
  detail: number;
};

export type NativeProcessResult = {
  width: number;
  height: number;
  decodeMs: number;
  processMs: number;
  encodeMs: number;
  totalMs: number;
  filter: NativeFilterKey;
};

/** 几何变换（warp / resize / rotate）的耗时统计，filter 字段是操作名 */
export type NativeGeometryResult = {
  width: number;
  height: number;
  decodeMs: number;
  processMs: number;
  encodeMs: number;
  totalMs: number;
  filter: 'warp' | 'resize' | 'rotate';
};

type ImageCoreNativeModule = {
  version(): string;
  processFile(
    inputPath: string,
    outputPath: string,
    filter: NativeFilterKey,
    quality: number,
  ): Promise<NativeProcessResult>;
  /** 旧版本的原生库没有这个方法，调用前要判断 */
  processFileEx?(
    inputPath: string,
    outputPath: string,
    filter: NativeFilterKey,
    quality: number,
    contrast: number,
    brightness: number,
    detail: number,
  ): Promise<NativeProcessResult>;
  /** 一页一张图直接写 PDF，返回实际页数；旧版本没有这个方法 */
  createPdf?(
    inputPaths: string[],
    outputPath: string,
    pageWidth: number,
    pageHeight: number,
  ): Promise<number>;
  /** 四角透视裁剪；quad 为 8 个归一化坐标 TL,TR,BR,BL */
  warpFile?(
    inputPath: string,
    outputPath: string,
    quad: number[],
    quality: number,
    maxDim: number,
  ): Promise<NativeGeometryResult>;
  /** 等比缩放到最长边 maxDim（不放大） */
  resizeFile?(
    inputPath: string,
    outputPath: string,
    maxDim: number,
    quality: number,
  ): Promise<NativeGeometryResult>;
  /** 顺时针旋转 90 / 180 / 270 */
  rotateFile?(
    inputPath: string,
    outputPath: string,
    degrees: number,
    quality: number,
  ): Promise<NativeGeometryResult>;
};

/**
 * Expo Go 里没有这个原生模块，requireNativeModule 会抛错。
 * 这里只记录可用的实例，让上层可以退回到 WebView 实现。
 */
let nativeModule: ImageCoreNativeModule | null = null;
let loadError: Error | null = null;

try {
  nativeModule = requireNativeModule<ImageCoreNativeModule>('ImageCore');
} catch (e) {
  loadError = e instanceof Error ? e : new Error(String(e));
}

export function isImageCoreAvailable(): boolean {
  return nativeModule != null;
}

export function imageCoreVersion(): string | null {
  return nativeModule?.version() ?? null;
}

export function imageCoreLoadError(): Error | null {
  return loadError;
}

/** 原生库是否支持第二步微调（processFileEx） */
export function isNativeAdjustAvailable(): boolean {
  return typeof nativeModule?.processFileEx === 'function';
}

export async function processFileWithNative(
  inputPath: string,
  outputPath: string,
  filter: NativeFilterKey,
  quality = 92,
  adjust?: NativeAdjust | null,
): Promise<NativeProcessResult> {
  if (!nativeModule) {
    throw loadError ?? new Error('ImageCore 原生模块不可用');
  }
  const ex = nativeModule.processFileEx;
  if (adjust && ex && (adjust.contrast || adjust.brightness || adjust.detail)) {
    return ex.call(
      nativeModule,
      inputPath,
      outputPath,
      filter,
      quality,
      adjust.contrast,
      adjust.brightness,
      adjust.detail,
    );
  }
  return nativeModule.processFile(inputPath, outputPath, filter, quality);
}

/** 原生库是否支持直接写 PDF */
export function isNativePdfAvailable(): boolean {
  return typeof nativeModule?.createPdf === 'function';
}

/**
 * 原生写 PDF：逐页解码 → 画进 PDF 页面，全部在原生侧完成。
 * 只有旧版本原生库 / Expo Go 才需要走 expo-print 的 HTML 路径。
 */
export async function createPdfWithNative(
  inputPaths: string[],
  outputPath: string,
  pageWidth: number,
  pageHeight: number,
): Promise<number> {
  if (!nativeModule?.createPdf) {
    throw loadError ?? new Error('ImageCore 原生模块不支持写 PDF');
  }
  return nativeModule.createPdf(inputPaths, outputPath, pageWidth, pageHeight);
}

/** 原生库是否支持 C++ 几何变换（裁剪 / 缩放 / 旋转） */
export function isNativeGeometryAvailable(): boolean {
  return (
    typeof nativeModule?.warpFile === 'function' &&
    typeof nativeModule?.resizeFile === 'function' &&
    typeof nativeModule?.rotateFile === 'function'
  );
}

/** 四角透视裁剪：quad 为 8 个归一化坐标 TL,TR,BR,BL */
export async function warpFileWithNative(
  inputPath: string,
  outputPath: string,
  quad: number[],
  maxDim: number,
  quality = 92,
): Promise<NativeGeometryResult> {
  if (!nativeModule?.warpFile) {
    throw loadError ?? new Error('ImageCore 原生模块不支持透视裁剪');
  }
  return nativeModule.warpFile(inputPath, outputPath, quad, quality, maxDim);
}

/** 等比缩放到最长边 maxDim（不放大） */
export async function resizeFileWithNative(
  inputPath: string,
  outputPath: string,
  maxDim: number,
  quality = 92,
): Promise<NativeGeometryResult> {
  if (!nativeModule?.resizeFile) {
    throw loadError ?? new Error('ImageCore 原生模块不支持缩放');
  }
  return nativeModule.resizeFile(inputPath, outputPath, maxDim, quality);
}

/** 顺时针旋转 90 / 180 / 270 */
export async function rotateFileWithNative(
  inputPath: string,
  outputPath: string,
  degrees: number,
  quality = 92,
): Promise<NativeGeometryResult> {
  if (!nativeModule?.rotateFile) {
    throw loadError ?? new Error('ImageCore 原生模块不支持旋转');
  }
  return nativeModule.rotateFile(inputPath, outputPath, degrees, quality);
}
