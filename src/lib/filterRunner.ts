import * as FileSystem from 'expo-file-system/legacy';

import { filterWithCanvas } from './filterEngine';
import {
  filterWithNative,
  isNativeAdjustAvailable,
  isNativeFilterAvailable,
} from './filterNative';
import { readBase64 } from './imagePipeline';
import type { PageAdjust } from './filters';
import { isZeroAdjust } from './filters';
import type { FilterKey } from '../types';

export type FilteredImage = {
  /** 结果所在位置：原生返回文件路径，Canvas 返回 data URL */
  uri: string;
  /** 仅 Canvas 路径提供；写入文件时不必再解码 data URL */
  base64?: string;
  source: 'native' | 'canvas';
  /** 原生产物是缓存目录里的临时文件，用完应调用 discardFiltered() */
  temp?: boolean;
};

/** data:image/jpeg;base64,xxx -> xxx */
export function stripDataUrl(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

/**
 * 对一张图执行滤镜，自动选择原生 / Canvas 引擎。
 *
 * 这是导入自动处理、批量应用、单页编辑共用的入口：
 * 调用方拿到结果后负责写入项目目录（原生是缓存文件，Canvas 是 base64）。
 * key 为 'original' 时原样返回输入，不做任何编解码。
 */
export async function applyFilter(
  uri: string,
  key: FilterKey,
  adjust?: PageAdjust | null,
): Promise<FilteredImage> {
  // 原图 + 无微调：直接用输入，省一次解码/编码
  if (key === 'original' && isZeroAdjust(adjust)) {
    return { uri, source: 'native' };
  }
  const nativeCanHandleAdjust =
    isZeroAdjust(adjust) || isNativeAdjustAvailable();
  if (isNativeFilterAvailable() && nativeCanHandleAdjust) {
    const out = await filterWithNative(uri, key, adjust);
    return { uri: out.uri, source: 'native', temp: true };
  }
  const base64 = stripDataUrl(
    await filterWithCanvas(await readBase64(uri), key, adjust),
  );
  return { uri: `data:image/jpeg;base64,${base64}`, base64, source: 'canvas' };
}

/**
 * 把滤镜结果落盘到 targetUri。
 *
 * 原生路径直接拷贝文件（不经过 base64），Canvas 路径写 base64；
 * 两种路径的调用方都不需要关心来源。
 */
export async function writeFiltered(
  filtered: FilteredImage,
  targetUri: string,
): Promise<void> {
  if (filtered.base64) {
    await FileSystem.writeAsStringAsync(targetUri, filtered.base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return;
  }
  await FileSystem.copyAsync({ from: filtered.uri, to: targetUri });
}

/** 删除原生路径留下的缓存文件；Canvas 路径与 original 输入都是无操作 */
export async function discardFiltered(
  filtered: FilteredImage | null | undefined,
): Promise<void> {
  if (!filtered?.temp) return;
  await FileSystem.deleteAsync(filtered.uri, { idempotent: true }).catch(() => {});
}
