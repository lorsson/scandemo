import {
  detectFileWithNative,
  isNativeDetectionAvailable,
  type NativeDetection,
} from '../../modules/image-core';
import { isUsableQuad, quadToArray } from './crop';
import {
  setDocumentEdgeDetector,
  type DocumentDetection,
  type DocumentEdgeDetector,
} from './documentDetection';
import { toFilePath, warpPerspective } from './imagePipeline';
import type { DocumentQuad } from '../types';

/**
 * 端侧文档检测接入点：Android 走 DocCornerNet（ONNX Runtime），
 * iOS 走系统 Vision（VNDetectDocumentSegmentationRequest）。
 *
 * 原生的 `detectFile` 已经做过阈值/凸性/面积过滤，这里再做一次 JS 侧防御：
 * 坐标必须在 [0,1]、面积合理、不是整图。任何不合格的结果都当作「没检测到」，
 * 由调用方保留原图。
 */
function normalizeDetection(raw: NativeDetection | null): DocumentDetection | null {
  if (!raw || !Number.isFinite(raw.confidence)) return null;
  const q = raw.quad;
  if (!q?.topLeft || !q.topRight || !q.bottomRight || !q.bottomLeft) {
    return null;
  }

  const quad: DocumentQuad = {
    topLeft: { x: q.topLeft.x, y: q.topLeft.y },
    topRight: { x: q.topRight.x, y: q.topRight.y },
    bottomRight: { x: q.bottomRight.x, y: q.bottomRight.y },
    bottomLeft: { x: q.bottomLeft.x, y: q.bottomLeft.y },
  };
  if (!isUsableQuad(quad)) return null;

  return { quad, confidence: raw.confidence };
}

const nativeDetector: DocumentEdgeDetector = {
  name: 'doccornernet',
  isAvailable: () => isNativeDetectionAvailable(),
  async detect(uri) {
    return normalizeDetection(await detectFileWithNative(toFilePath(uri)));
  },
  async warp(uri, quad, options) {
    const output = await warpPerspective(
      uri,
      quadToArray(quad),
      options?.maxDim ?? 1600,
    );
    return { uri: output };
  },
};

let registered = false;

/** App 启动时调用一次；Expo Go 里没有原生模块，detector 会保持 unavailable */
export function registerNativeDocumentDetector(): void {
  if (registered) return;
  registered = true;
  setDocumentEdgeDetector(nativeDetector);
}

export { normalizeDetection };
