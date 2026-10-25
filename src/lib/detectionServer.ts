import * as FileSystem from 'expo-file-system/legacy';

import { isUsableQuad, quadFromPoints } from './crop';
import type { DocumentDetection } from './documentDetection';
import { getImageSize, readBase64, resizeImage } from './imagePipeline';

/** demo.py 的接口：POST JSON { image: base64 } */
export const DETECTION_ENDPOINT = '/api/edgeDetector';

// 服务端不可达时必须很快退化到端侧识别，否则点「裁剪」会像卡死一样
const DEFAULT_TIMEOUT_MS = 4000;
/**
 * 上传图「短边」上限。竖向 A4 的短边就是页宽，压到 1280 后长边约 1800——
 * 长边按 1280 压只剩 960 宽，细边框和表格线会糊掉，1228 反而更容易认偏。
 * 横版/竖版同一套规则：短边对齐 1280，长边按原始比例跟着走。
 */
const UPLOAD_MAX_SHORT_SIDE = 1280;

type ServerResponse = {
  code?: number;
  message?: string;
  data?: { points?: unknown };
};

function withTimeout(signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
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

async function postImage(
  url: string,
  base64: string,
  signal?: AbortSignal,
): Promise<ServerResponse> {
  const timeout = withTimeout(signal);
  try {
    const response = await fetch(url, {
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
    return json;
  } finally {
    timeout.dispose();
  }
}

function parsePoints(value: unknown): { x: number; y: number }[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const points: { x: number; y: number }[] = [];
  for (const item of value) {
    let x: number;
    let y: number;
    if (Array.isArray(item) && item.length >= 2) {
      x = Number(item[0]);
      y = Number(item[1]);
    } else if (item && typeof item === 'object') {
      const p = item as { x?: unknown; y?: unknown };
      x = Number(p.x);
      y = Number(p.y);
    } else {
      return null;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push({ x, y });
  }
  return points;
}

/**
 * 短边限制换算成 resizeImage 认识的长边上限。
 *
 * resizeImage 只接受「最长边」；短边没超限时原样返回长边（配合 alwaysEncode
 * 只重新编码、不缩放），超限时按同一比例把长边一起缩下来。
 */
async function uploadMaxDim(uri: string, maxShortSide: number): Promise<number> {
  const { width, height } = await getImageSize(uri);
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (shortSide <= maxShortSide || shortSide === 0) return longSide;
  return Math.round((maxShortSide * longSide) / shortSide);
}

/**
 * 调服务端 model_1228 重新识别四角。
 *
 * 传进来的 uri 是用户当前看到的图片（已旋转/未滤镜的 baseUri）；
 * 返回的 quad 归一化到同一张图，可直接交给裁剪框。
 * 服务端无把握时会退回整图四角，这里用 isUsableQuad 过滤成 null。
 */
export async function detectOnServer(
  uri: string,
  baseUrl: string,
  options: { signal?: AbortSignal; maxShortSide?: number } = {},
): Promise<DocumentDetection | null> {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) return null;

  let uploadUri = uri;
  let temporary = false;
  try {
    // 统一按 JPEG 90% 重新编码上传：服务端只做角点识别，90% 完全够用，
    // 截屏/PNG 原图也能把体积压到几百 KB，避免 JSON base64 太大导致超时。
    const uploadDim = await uploadMaxDim(
      uri,
      options.maxShortSide ?? UPLOAD_MAX_SHORT_SIDE,
    );
    uploadUri = await resizeImage(uri, uploadDim, 0.9, true);
    temporary = uploadUri !== uri;
    const { width, height } = await getImageSize(uploadUri);
    const base64 = await readBase64(uploadUri);
    const payload = await postImage(
      `${base}${DETECTION_ENDPOINT}`,
      base64,
      options.signal,
    );
    const points = parsePoints(payload.data?.points);
    if (!points) return null;

    const quad = quadFromPoints(points, width, height);
    if (!quad || !isUsableQuad(quad)) return null;
    return { quad, confidence: 1 };
  } finally {
    if (temporary) {
      await FileSystem.deleteAsync(uploadUri, { idempotent: true }).catch(
        () => {},
      );
    }
  }
}

/** 设置页的连通性测试：能收到 HTTP 响应（包括 404）就算可达 */
export async function testDetectionServer(
  baseUrl: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${base}${DETECTION_ENDPOINT}`, {
      method: 'GET',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
