import {
  isNativeOcrAvailable,
  ocrFileWithNative,
  type NativeOcrLine,
} from '../../modules/image-core';
import { toFilePath } from './imagePipeline';
import { buildLines, type OcrLine } from './ocr';
import type { NormalizedPoint } from '../types';

/**
 * 端侧文字识别：Android 跑 PP-OCRv4（ONNX，det + cls + rec），iOS 用系统
 * Vision；两边的原生契约与服务端 `/api/ocr` 一致 —— 返回位图像素坐标，这里换成
 * 归一化坐标，上层（OcrScreen / 编辑 / 导出）完全不感知推理在哪跑。
 *
 * Expo Go 没有原生模块；isOnDeviceOcrAvailable() 为 false 时退回服务端。
 */
export function isOnDeviceOcrAvailable(): boolean {
  return isNativeOcrAvailable();
}

function parseBox(value: unknown): NormalizedPoint[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const points: NormalizedPoint[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2) return null;
    const x = Number(item[0]);
    const y = Number(item[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push({ x, y });
  }
  return points;
}

export async function recognizeOnDevice(uri: string): Promise<OcrLine[]> {
  if (!isNativeOcrAvailable()) {
    throw new Error('On-device OCR is not available');
  }
  const result = await ocrFileWithNative(toFilePath(uri));
  const width = Number(result?.width);
  const height = Number(result?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return [];
  }

  const rawLines: NativeOcrLine[] = Array.isArray(result.lines) ? result.lines : [];
  const normalized = rawLines
    .map((raw) => {
      const points = parseBox(raw?.points);
      if (!points) return null;
      return {
        points: points.map((point) => ({
          x: Math.min(1, Math.max(0, point.x / width)),
          y: Math.min(1, Math.max(0, point.y / height)),
        })),
        text: typeof raw.text === 'string' ? raw.text : '',
        score: Number(raw.score) || 0,
      };
    })
    .filter((line): line is NonNullable<typeof line> => line !== null);

  return buildLines(normalized);
}
