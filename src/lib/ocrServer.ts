import * as FileSystem from 'expo-file-system/legacy';

import { buildLines, type OcrLine } from './ocr';
import { getImageSize, readBase64, resizeImage } from './imagePipeline';
import type { NormalizedPoint } from '../types';

/**
 * 服务端 OCR：`demo.py` 的 POST /api/ocr。
 *
 * 请求 `{ image: base64 }`，返回
 *   `{ code: 200, data: { width, height, lines: [{ points: [[x,y] x4], text, score }] } }`
 * points 是上传图的像素坐标；客户端换成归一化坐标，端侧推理以后沿用同一契约。
 */
export const OCR_ENDPOINT = '/api/ocr';

/**
 * 一页文字多时（90 行）桌面 CPU 也要 6s 左右，冷启动建模型更久；
 * 超时给足，宁可让用户等也不要中途失败。
 */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * 上传图短边上限。OCR 对细笔画敏感，比四角检测（1280）留得更大：
 * 扫描页本身长边 ≤1600，所以实际几乎不缩放，只是统一转成 JPEG 90%。
 */
const UPLOAD_MAX_SHORT_SIDE = 1600;

type RawLine = { points?: unknown; text?: unknown; score?: unknown };

type ServerResponse = {
  code?: number;
  message?: string;
  data?: { width?: unknown; height?: unknown; lines?: unknown };
};

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort);
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    },
  };
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

async function uploadMaxDim(uri: string, maxShortSide: number): Promise<number> {
  const { width, height } = await getImageSize(uri);
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (shortSide <= maxShortSide || shortSide === 0) return longSide;
  return Math.round((maxShortSide * longSide) / shortSide);
}

export type OcrRecognizeOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

/**
 * 识别一张图，返回按阅读顺序排好的文本行（归一化坐标）。
 * 没有检测到文字时返回空数组；网络/服务错误向上抛。
 */
export async function recognizeOnServer(
  uri: string,
  baseUrl: string,
  options: OcrRecognizeOptions = {},
): Promise<OcrLine[]> {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) throw new Error('OCR server is not configured');

  let uploadUri = uri;
  let temporary = false;
  try {
    const uploadDim = await uploadMaxDim(uri, UPLOAD_MAX_SHORT_SIDE);
    uploadUri = await resizeImage(uri, uploadDim, 0.9, true);
    temporary = uploadUri !== uri;
    const { width, height } = await getImageSize(uploadUri);
    const base64 = await readBase64(uploadUri);

    const timeout = withTimeout(
      options.signal,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`${base}${OCR_ENDPOINT}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image: base64 }),
        signal: timeout.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as ServerResponse;
      if (json.code !== 200) {
        throw new Error(json.message ?? `server code ${json.code ?? 'unknown'}`);
      }

      const rawLines = Array.isArray(json.data?.lines)
        ? (json.data?.lines as RawLine[])
        : [];
      const uploadWidth = Number(json.data?.width) || width;
      const uploadHeight = Number(json.data?.height) || height;

      const normalized = rawLines
        .map((raw) => {
          const points = parseBox(raw.points);
          if (!points) return null;
          return {
            points: points.map((point) => ({
              x: Math.min(1, Math.max(0, point.x / uploadWidth)),
              y: Math.min(1, Math.max(0, point.y / uploadHeight)),
            })),
            text: typeof raw.text === 'string' ? raw.text : '',
            score: Number(raw.score) || 0,
          };
        })
        .filter((line): line is NonNullable<typeof line> => line !== null);

      return buildLines(normalized);
    } finally {
      timeout.dispose();
    }
  } finally {
    if (temporary) {
      await FileSystem.deleteAsync(uploadUri, { idempotent: true }).catch(
        () => {},
      );
    }
  }
}
