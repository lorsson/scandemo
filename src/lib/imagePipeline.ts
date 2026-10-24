import { Image } from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';

import {
  isNativeGeometryAvailable,
  resizeFileWithNative,
  rotateFileWithNative,
  warpFileWithNative,
} from '../../modules/image-core';

/** 同一毫秒内并发处理多张图时，缓存文件名必须唯一 */
let fileSeq = 0;

function tempJpegPath(op: string): string {
  const cacheDir = FileSystem.cacheDirectory ?? '';
  return `${cacheDir}${op}-${Date.now()}-${++fileSeq}.jpg`;
}

export function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

/** BitmapFactory / CGImageSource 需要真实的文件路径，不能带 file:// */
export function toFilePath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

function toJpegQuality(compress: number): number {
  return Math.max(1, Math.min(100, Math.round(compress * 100)));
}

/** 把打包进 app 的静态图片解析为本地 file uri */
export async function resolveBundledAsset(moduleId: number): Promise<string> {
  const asset = Asset.fromModule(moduleId);
  // Expo Go / expo-updates 直接给到磁盘路径，可以直接用。
  // （独立包里 localUri 可能是 drawable 资源名，所以必须确认是 file://）
  if (asset.localUri?.startsWith('file://') && !asset.localUri.startsWith('file:///android_res/')) {
    return asset.localUri;
  }
  // 独立安装包里，打包图片会被 aapt 编成 drawable 资源，expo-asset 解析出的
  // uri 是资源名（如 "3c"）或 file:///android_res/...，都不是文件路径，
  // Image.getSize / ImageManipulator 读不了。清掉 downloaded 标记，让
  // expo-asset 走原生分支把资源复制到缓存目录。
  asset.localUri = null;
  asset.downloaded = false;
  await asset.downloadAsync();
  if (!asset.localUri) {
    console.warn('[image-core] 资源提取失败', asset.uri);
  }
  return asset.localUri ?? asset.uri;
}

export function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

/**
 * 按最长边等比缩小并重新编码为 JPEG。
 * alwaysEncode=true 时即使尺寸没超限也会转成 JPEG——PDF 源图需要稳定的
 * .jpg 扩展名和 MIME，不能把 PNG/HEIC 原文件直接拷进去。
 */
export async function resizeImage(
  uri: string,
  maxDim: number,
  compress = 0.92,
  alwaysEncode = false,
): Promise<string> {
  const { width, height } = await getImageSize(uri);
  const largest = Math.max(width, height);
  if (largest <= maxDim && !alwaysEncode) {
    return uri;
  }

  // 原生 C++ 缩放：超限时盒式平均下采样，未超限时只重新编码（alwaysEncode）
  if (isNativeGeometryAvailable()) {
    try {
      const path = toFilePath(tempJpegPath('resize'));
      const timings = await resizeFileWithNative(
        toFilePath(uri),
        path,
        maxDim,
        toJpegQuality(compress),
      );
      console.log(
        `[image-core] resize ${timings.width}x${timings.height} ` +
          `decode=${timings.decodeMs}ms process=${timings.processMs}ms ` +
          `encode=${timings.encodeMs}ms total=${timings.totalMs}ms`,
      );
      return toFileUri(path);
    } catch (error) {
      console.warn(
        '[image-core] native resize failed, falling back to image-manipulator:',
        error,
      );
    }
  }

  const scale = largest > maxDim ? maxDim / largest : 1;
  const result = await manipulateAsync(
    uri,
    [{
      resize: {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      },
    }],
    { compress, format: SaveFormat.JPEG },
  );
  return result.uri;
}

/**
 * 按目标宽度等比缩小（不放大），用于列表缩略图。
 *
 * 原生 resize 是按最长边缩的，所以这里先把目标宽高算出来，再把它换成
 * 「最长边」交给 resizeImage —— 结果与 `resize: { width }` 一致。
 * 缩略图也是像素处理，同样走 C++，不在 JS 侧调用 image-manipulator。
 */
export async function resizeToWidth(
  uri: string,
  width: number,
  compress = 0.72,
): Promise<string> {
  const { width: srcWidth, height: srcHeight } = await getImageSize(uri);
  const targetWidth = Math.max(1, Math.min(width, srcWidth));
  const targetHeight = Math.max(
    1,
    Math.round((srcHeight * targetWidth) / srcWidth),
  );
  return resizeImage(uri, Math.max(targetWidth, targetHeight), compress, true);
}

/**
 * 预览用的标准尺寸。再大只会增加 WebView 与磁盘的开销，
 * 1400px 对手机查看已经足够清晰。
 */
export function prepareBase(uri: string, maxDim = 1400): Promise<string> {
  return resizeImage(uri, maxDim, 0.92);
}

/** 顺时针旋转 90 / 180 / 270；优先走 C++，Expo Go 里退回 image-manipulator */
export async function rotateImage(uri: string, degree: 90 | 180 | 270): Promise<string> {
  if (isNativeGeometryAvailable()) {
    try {
      const path = toFilePath(tempJpegPath('rotate'));
      const timings = await rotateFileWithNative(
        toFilePath(uri),
        path,
        degree,
        95,
      );
      console.log(
        `[image-core] rotate ${degree}deg ${timings.width}x${timings.height} ` +
          `decode=${timings.decodeMs}ms process=${timings.processMs}ms ` +
          `encode=${timings.encodeMs}ms total=${timings.totalMs}ms`,
      );
      return toFileUri(path);
    } catch (error) {
      console.warn(
        '[image-core] native rotate failed, falling back to image-manipulator:',
        error,
      );
    }
  }

  const result = await manipulateAsync(uri, [{ rotate: degree }], {
    compress: 0.95,
    format: SaveFormat.JPEG,
  });
  return result.uri;
}

/**
 * 四角透视裁剪（C++）：把 quad 内的四边形拉成矩形，返回缓存目录里的 JPEG。
 * quad 是 8 个归一化坐标 TL,TR,BR,BL；调用方负责删除返回的文件。
 */
export async function warpPerspective(
  uri: string,
  quad: number[],
  maxDim = 1600,
): Promise<string> {
  const path = toFilePath(tempJpegPath('warp'));
  const timings = await warpFileWithNative(
    toFilePath(uri),
    path,
    quad,
    maxDim,
    92,
  );
  console.log(
    `[image-core] warp ${timings.width}x${timings.height} ` +
      `decode=${timings.decodeMs}ms process=${timings.processMs}ms ` +
      `encode=${timings.encodeMs}ms total=${timings.totalMs}ms`,
  );
  return toFileUri(path);
}

export async function readBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: 'base64' as any });
}
