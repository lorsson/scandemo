import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import type { ComponentType, Ref } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

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

export type NativeDetection = {
  /** 归一化坐标，顺序 TL,TR,BR,BL（与 DocumentQuad 结构一致） */
  quad: {
    topLeft: { x: number; y: number };
    topRight: { x: number; y: number };
    bottomRight: { x: number; y: number };
    bottomLeft: { x: number; y: number };
  };
  confidence: number;
};

/** 实时取景事件：quad 是 8 个「预览视图」归一化坐标 TL,TR,BR,BL */
export type LiveQuadPayload = {
  detected: boolean;
  quad: number[] | null;
  confidence: number;
};

/** 相机/模型侧的非致命错误；JS 只在开发构建里提示，正式包静默降级 */
export type CameraIssuePayload = {
  /** `camera` | `model` */
  kind: string;
  message: string;
};

export type NativeCameraViewProps = {
  style?: StyleProp<ViewStyle>;
  onQuad?: (event: { nativeEvent: LiveQuadPayload }) => void;
  onError?: (event: { nativeEvent: CameraIssuePayload }) => void;
};

export type NativeCameraViewHandle = {
  takePicture(): Promise<{ uri: string; width: number; height: number }>;
};

type ImageCoreNativeModule = {
  version(): string;
  /** 实时相机 View 是否注册（Android CameraX / iOS AVCaptureSession） */
  isCameraAvailable?(): boolean;
  /** 端侧文档四角检测；path 不带 file://（Android DocCornerNet / iOS Vision） */
  detectFile?(path: string): Promise<NativeDetection | null>;
  /** 按 EXIF 转正后的像素尺寸；path 不带 file:// */
  imageSize?(path: string): Promise<{ width: number; height: number }>;
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

/** 原生库是否带端侧文档检测（Android DocCornerNet / iOS Vision） */
export function isNativeDetectionAvailable(): boolean {
  return typeof nativeModule?.detectFile === 'function';
}

/** 端侧文档四角检测；path 不带 file://。没有文档时返回 null */
export async function detectFileWithNative(
  path: string,
): Promise<NativeDetection | null> {
  if (!nativeModule?.detectFile) {
    throw loadError ?? new Error('ImageCore 原生模块不支持文档检测');
  }
  return nativeModule.detectFile(path);
}

/** 原生库是否能按 EXIF 转正读尺寸 */
export function isNativeImageSizeAvailable(): boolean {
  return typeof nativeModule?.imageSize === 'function';
}

/**
 * 按 EXIF 转正后的像素尺寸。竖拍照片与 RN Image 的显示方向一致，
 * 而 `Image.getSize` 返回的是文件里的原始宽高（可能差 90°）。
 */
export async function imageSizeWithNative(
  path: string,
): Promise<{ width: number; height: number }> {
  if (!nativeModule?.imageSize) {
    throw loadError ?? new Error('ImageCore 原生模块不支持读取图片尺寸');
  }
  return nativeModule.imageSize(path);
}

/** 是否支持原生实时取景（Android CameraX / iOS AVCaptureSession） */
export function isNativeCameraAvailable(): boolean {
  return (
    typeof nativeModule?.isCameraAvailable === 'function' &&
    nativeModule.isCameraAvailable() === true
  );
}

/** 原生视图实例暴露的方法；ref 直接拿到这个对象 */
export type NativeCameraViewComponent = ComponentType<
  NativeCameraViewProps & { ref?: Ref<NativeCameraViewHandle> }
>;

let cachedCameraView: NativeCameraViewComponent | null | undefined;

/**
 * 原生实时取景组件。不可用时返回 null，调用方退回 expo-camera。
 * 注意：Expo Go 里没有该视图，必须先用 isNativeCameraAvailable() 判断。
 */
export function getNativeCameraView(): NativeCameraViewComponent | null {
  if (cachedCameraView !== undefined) return cachedCameraView;
  if (!isNativeCameraAvailable()) {
    cachedCameraView = null;
    return null;
  }
  try {
    cachedCameraView = requireNativeViewManager<NativeCameraViewProps>(
      'ImageCore',
      'ImageCoreCameraView',
    );
  } catch (error) {
    console.warn('[image-core] native camera view unavailable:', error);
    cachedCameraView = null;
  }
  return cachedCameraView;
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
