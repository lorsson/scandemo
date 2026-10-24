import * as FileSystem from 'expo-file-system/legacy';

import {
  isImageCoreAvailable,
  imageCoreVersion,
  processFileWithNative,
  type NativeFilterKey,
  type NativeProcessResult,
} from '../../modules/image-core';
import type { FilterKey } from '../types';

export type FilteredImage = {
  /** 可以直接给 <Image source={{ uri }} /> 用 */
  uri: string;
  /** 文件路径（原生处理产物才有） */
  path?: string;
  source: 'native' | 'canvas';
  timings?: NativeProcessResult;
};

export function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

/** BitmapFactory / CGImageSource 需要真实的文件路径，不能带 file:// */
export function toFilePath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

export function isNativeFilterAvailable(): boolean {
  return isImageCoreAvailable();
}

export function nativeCoreVersion(): string | null {
  return imageCoreVersion();
}

/**
 * 原生 C++ 处理：读文件 -> 原地改像素 -> 写 JPEG。
 * 不经过 base64，省掉一次 5~10MB 的字符串拷贝。
 */
export async function filterWithNative(uri: string, filter: FilterKey): Promise<FilteredImage> {
  const cacheDir = FileSystem.cacheDirectory ?? '';
  const outputPath = `${cacheDir}filter-${filter}-${Date.now()}.jpg`;

  const timings = await processFileWithNative(
    toFilePath(uri),
    toFilePath(outputPath),
    filter as NativeFilterKey,
    92,
  );

  const path = toFilePath(outputPath);
  // 开发期在 Metro 日志里看 decode / process / encode 各占多少毫秒
  console.log(
    `[image-core] ${filter} ${timings.width}x${timings.height} ` +
      `decode=${timings.decodeMs}ms process=${timings.processMs}ms ` +
      `encode=${timings.encodeMs}ms total=${timings.totalMs}ms`,
  );
  return { uri: toFileUri(path), path, source: 'native', timings };
}
