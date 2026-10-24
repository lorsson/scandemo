/**
 * 文档边缘检测 / 透视切边——预留接口。
 *
 * 目标流程：
 *   图片 → ONNX 模型推理 → 文档四角（归一化坐标）
 *        → 透视变换（warpPerspective）→ 拉正后的图片
 *
 * 当前仓库没有打包模型，也没有原生实现，所以默认 detector 不可用；
 * 调用方应先用 isEdgeDetectionAvailable() 判断，再决定是否展示「切边」。
 *
 * ── 原生接入约定（Android / iOS / 鸿蒙共用同一套语义）────────────────
 *
 * detect(uri):
 *   - uri: 本地 file:// 路径
 *   - 输出四角顺序固定为 topLeft → topRight → bottomRight → bottomLeft（顺时针）
 *   - 坐标是相对原图的归一化值 [0,1]，调用方不需要知道原图分辨率
 *   - confidence 取 [0,1]；无法确定文档时返回 null
 *   - 实现内部应先把图解码到模型输入尺寸（常见 512×512），推理完立即释放
 *
 * warp(uri, quad):
 *   - quad 与 detect 的输出语义一致
 *   - 输出与输入同宽高比、最长边不超过 maxDim 的 JPEG 文件
 *   - 建议放在共享 C++ 里（与滤镜同一套像素契约），各平台只做解码/编码
 *
 * detectBatch(uris):
 *   - 可选。原生侧复用同一个 ONNX session，按 batchSize 组批推理；
 *     不实现时框架会退化为有界并发的单张 detect
 *   - 不要把整批图片解码后同时留在内存里：内存上界应为
 *     O(batchSize × 模型输入) + O(1 张全尺寸图)
 *
 * 推荐模型：输入 512×512，输出 4 点回归或角点热图；优先用端侧加速
 * （Android NNAPI/QNN、iOS Core ML、鸿蒙 NNRt），不可用时回退 CPU。
 */

import { throwIfAborted } from './abort';
import type { DocumentQuad } from '../types';

export type { DocumentQuad, NormalizedPoint } from '../types';

export type DocumentDetection = {
  quad: DocumentQuad;
  /** 0..1 */
  confidence: number;
};

export type DetectionOptions = {
  signal?: AbortSignal;
};

export type BatchDetectionOptions = DetectionOptions & {
  /**
   * 同时在途的单张推理数。手机默认 1：并行解码多张大图会直接推高内存，
   * 而且端侧 NPU 往往本来就在内部串行。
   */
  concurrency?: number;
  /**
   * 原生批量推理的 batch size。仅作为提示传给实现了 detectBatch 的 detector；
   * JS 兜底路径始终一张一张跑。
   */
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
};

export type WarpOptions = {
  /** 输出最长边，默认 1600 */
  maxDim?: number;
  /** JPEG 质量，默认 0.9 */
  quality?: number;
  signal?: AbortSignal;
};

export type WarpResult = {
  uri: string;
};

export interface DocumentEdgeDetector {
  readonly name: string;
  isAvailable(): boolean;
  detect(uri: string, options?: DetectionOptions): Promise<DocumentDetection | null>;
  /** 可选：原生批量推理；不实现则由 detectDocumentBatch 串行/有界并发兜底 */
  detectBatch?(
    uris: string[],
    options?: BatchDetectionOptions,
  ): Promise<(DocumentDetection | null)[]>;
  /** 可选：透视切边；不实现时 warpDocumentQuad 抛「尚未实现」 */
  warp?(uri: string, quad: DocumentQuad, options?: WarpOptions): Promise<WarpResult>;
}

function unavailable(): Error {
  return new Error('文档边缘检测尚未接入（预留了 ONNX 接口）');
}

const unavailableDetector: DocumentEdgeDetector = {
  name: 'none',
  isAvailable: () => false,
  detect: async () => {
    throw unavailable();
  },
};

let activeDetector: DocumentEdgeDetector = unavailableDetector;

/**
 * 注册原生 detector。适合在模块初始化时调用一次，或在测试里注入假实现。
 */
export function setDocumentEdgeDetector(detector: DocumentEdgeDetector): void {
  activeDetector = detector;
}

export function isEdgeDetectionAvailable(): boolean {
  return activeDetector.isAvailable();
}

export async function detectDocumentQuad(
  uri: string,
  options: DetectionOptions = {},
): Promise<DocumentDetection | null> {
  throwIfAborted(options.signal);
  if (!activeDetector.isAvailable()) throw unavailable();
  return activeDetector.detect(uri, options);
}

/**
 * 批量检测。结果数组与输入顺序一一对应，未检测到文档的位置为 null。
 *
 * 内存上界：
 *   - 原生 detectBatch：O(batchSize × 模型输入) + 一张图的解码缓冲
 *   - JS 兜底：O(concurrency × 模型输入)
 * 与图片总数无关，所以支持几百张图的关键是「不要把结果图/位图留在 JS 里」——
 * 四角是几个数字，结果数组本身很小；全尺寸图只在 warp 阶段一张张处理。
 */
export async function detectDocumentBatch(
  uris: string[],
  options: BatchDetectionOptions = {},
): Promise<(DocumentDetection | null)[]> {
  const total = uris.length;
  if (total === 0) return [];
  if (!activeDetector.isAvailable()) throw unavailable();
  throwIfAborted(options.signal);

  if (activeDetector.detectBatch) {
    const result = await activeDetector.detectBatch(uris, options);
    options.onProgress?.(total, total);
    return result;
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, total));
  const results = new Array<DocumentDetection | null>(total).fill(null);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted(options.signal);
      const index = next++;
      if (index >= total) return;
      results[index] = await activeDetector.detect(uris[index], {
        signal: options.signal,
      });
      done++;
      options.onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * 透视切边。四角按 TL/TR/BR/BL 传入，输出新的 JPEG 文件路径。
 * 原生实现未接入时抛错，UI 应展示「预留」提示而不是让流程失败。
 */
export async function warpDocumentQuad(
  uri: string,
  quad: DocumentQuad,
  options: WarpOptions = {},
): Promise<WarpResult> {
  throwIfAborted(options.signal);
  if (!activeDetector.isAvailable()) throw unavailable();
  if (!activeDetector.warp) {
    throw new Error('透视切边尚未实现：ONNX 检测已接入，但缺少 warp 步骤');
  }
  return activeDetector.warp(uri, quad, options);
}

/** 四角是否都在 [0,1] 且顺序大致合理；原生结果回来后可做一次防御性校验 */
export function isQuadInRange(quad: DocumentQuad): boolean {
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  if (points.some((p) => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return false;
  return (
    quad.topLeft.x < quad.topRight.x &&
    quad.bottomLeft.x < quad.bottomRight.x &&
    quad.topLeft.y < quad.bottomLeft.y &&
    quad.topRight.y < quad.bottomRight.y
  );
}
