import * as FileSystem from 'expo-file-system/legacy';

import { getImageSize, resizeImage } from './imagePipeline';
import { t } from './i18n';

/**
 * OCR 工作目录：`<document>/ocr/<session>/`。
 *
 * 导入的图片统一转成 JPEG 落在会话目录里，之后裁剪、识别、导出都读这里的
 * 文件——相册返回的 content:// 或缓存路径随时可能失效，不能长期引用。
 * 导出文本放 `ocr/exports/`，用户能在「我的 → 文件」之外通过分享取走。
 */
const ROOT = `${FileSystem.documentDirectory ?? ''}ocr/`;
const EXPORT_DIR = `${ROOT}exports/`;

/** OCR 用的页面尺寸：比扫描页（1400）大一点，小字更稳 */
export const OCR_MAX_DIM = 1600;
const OCR_JPEG_QUALITY = 0.92;

export function ocrSessionDir(id: string): string {
  return `${ROOT}${id}/`;
}

export async function ensureOcrSession(id: string): Promise<string> {
  const dir = ocrSessionDir(id);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  return dir;
}

async function copyInto(sourceUri: string, target: string): Promise<void> {
  await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
  await FileSystem.copyAsync({ from: sourceUri, to: target });
}

/**
 * 把一张外部图片收进会话目录，返回最终的 file:// uri 和尺寸。
 * 统一重编码：HEIC/PNG 都变成 JPEG，服务端和端侧解码器都只面对一种格式。
 */
export async function importOcrPage(
  sourceUri: string,
  sessionId: string,
  index: number,
): Promise<{ uri: string; width: number; height: number }> {
  const dir = await ensureOcrSession(sessionId);
  const prepared = await resizeImage(
    sourceUri,
    OCR_MAX_DIM,
    OCR_JPEG_QUALITY,
    true,
  );
  const target = `${dir}page-${index}.jpg`;
  try {
    await copyInto(prepared, target);
  } finally {
    if (prepared !== sourceUri) {
      await FileSystem.deleteAsync(prepared, { idempotent: true }).catch(
        () => {},
      );
    }
  }
  const { width, height } = await getImageSize(target);
  return { uri: target, width, height };
}

/**
 * 裁剪结果是缓存里的临时文件：拷进会话目录后替换页面图。
 *
 * 每次换新文件名：RN Image 按 uri 缓存位图，同名覆盖会让界面继续显示旧图
 * （渲染用缓存图、识别读新文件，文本框就对不上）。旧文件顺手删掉。
 */
export async function replaceOcrPage(
  tempUri: string,
  sessionId: string,
  index: number,
  previousUri?: string,
): Promise<{ uri: string; width: number; height: number }> {
  const dir = await ensureOcrSession(sessionId);
  const target = `${dir}page-${index}-${Date.now().toString(36)}.jpg`;
  await copyInto(tempUri, target);
  if (previousUri && previousUri !== target) {
    await FileSystem.deleteAsync(previousUri, { idempotent: true }).catch(
      () => {},
    );
  }
  const { width, height } = await getImageSize(target);
  return { uri: target, width, height };
}

function fileNameSafe(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || t('ocrDefaultTitle');
}

/** 导出识别文本（UTF-8），返回文件路径 */
export async function writeOcrText(
  title: string,
  text: string,
): Promise<string> {
  await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
  const path = `${EXPORT_DIR}${fileNameSafe(title)}.txt`;
  await FileSystem.writeAsStringAsync(path, text, {
    encoding: 'utf8' as any,
  });
  return path;
}

/** 会话目录下的所有文件（页面图 + 以后可能有的中间产物） */
export async function removeOcrSession(sessionId: string): Promise<void> {
  await FileSystem.deleteAsync(ocrSessionDir(sessionId), {
    idempotent: true,
  }).catch(() => {});
}
