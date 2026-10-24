import * as FileSystem from 'expo-file-system/legacy';

import {
  isImageCoreAvailable,
  isNativeAdjustAvailable as nativeAdjustAvailable,
  imageCoreVersion,
  processFileWithNative,
  type NativeAdjust,
  type NativeFilterKey,
  type NativeProcessResult,
} from '../../modules/image-core';
import type { FilterKey } from '../types';
import { toFileUri, toFilePath } from './imagePipeline';

export { toFileUri, toFilePath };

/** 同一毫秒内并发处理多张预览图时，文件名必须唯一 */
let fileSeq = 0;

export type FilteredImage = {
  /** 可以直接给 <Image source={{ uri }} /> 用 */
  uri: string;
  /** 文件路径（原生处理产物才有） */
  path?: string;
  source: 'native' | 'canvas';
  timings?: NativeProcessResult;
};

export function isNativeFilterAvailable(): boolean {
  return isImageCoreAvailable();
}

/**
 * 旧原生库没有 processFileEx，此时带微调的请求必须走 Canvas，
 * 否则 processFile 会静默忽略对比度/亮度/细节。
 */
export function isNativeAdjustAvailable(): boolean {
  return nativeAdjustAvailable();
}

export function nativeCoreVersion(): string | null {
  return imageCoreVersion();
}

/**
 * 原生 C++ 处理：读文件 -> 原地改像素 -> 写 JPEG。
 * 不经过 base64，省掉一次 5~10MB 的字符串拷贝。
 */
export async function filterWithNative(
  uri: string,
  filter: FilterKey,
  adjust?: NativeAdjust | null,
): Promise<FilteredImage> {
  const cacheDir = FileSystem.cacheDirectory ?? '';
  const outputPath = `${cacheDir}filter-${filter}-${Date.now()}-${++fileSeq}.jpg`;

  const timings = await processFileWithNative(
    toFilePath(uri),
    toFilePath(outputPath),
    filter as NativeFilterKey,
    92,
    adjust,
  );

  const path = toFilePath(outputPath);
  // 开发期在 Metro 日志里看 decode / process / encode 各占多少毫秒
  const adjustTag =
    adjust && (adjust.contrast || adjust.brightness || adjust.detail)
      ? ` adjust=${adjust.contrast}/${adjust.brightness}/${adjust.detail}`
      : '';
  console.log(
    `[image-core] ${filter}${adjustTag} ${timings.width}x${timings.height} ` +
      `decode=${timings.decodeMs}ms process=${timings.processMs}ms ` +
      `encode=${timings.encodeMs}ms total=${timings.totalMs}ms`,
  );
  return { uri: toFileUri(path), path, source: 'native', timings };
}
