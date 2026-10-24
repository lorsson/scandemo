import type { DocumentQuad, NormalizedPoint } from '../types';

/**
 * 四角裁剪的坐标约定：
 *   - 归一化到**当前显示方向**的原图（永远是 originalUri，不含旋转/滤镜）
 *   - 顺时针顺序 TL → TR → BR → BL
 *
 * 智能裁剪在没有接入 ONNX 切边模型之前，默认就是整张图的四个角；
 * 用户可以拖动 4 个角点或 4 条边来修正。
 */
export const FULL_QUAD: DocumentQuad = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomRight: { x: 1, y: 1 },
  bottomLeft: { x: 0, y: 1 },
};

export function cloneQuad(quad: DocumentQuad): DocumentQuad {
  return {
    topLeft: { ...quad.topLeft },
    topRight: { ...quad.topRight },
    bottomRight: { ...quad.bottomRight },
    bottomLeft: { ...quad.bottomLeft },
  };
}

/** 原生桥要的 8 个归一化坐标：TL,TR,BR,BL（与 C++ warp 的顺序一致） */
export function quadToArray(quad: DocumentQuad): number[] {
  return [
    quad.topLeft.x,
    quad.topLeft.y,
    quad.topRight.x,
    quad.topRight.y,
    quad.bottomRight.x,
    quad.bottomRight.y,
    quad.bottomLeft.x,
    quad.bottomLeft.y,
  ];
}

function sanitizePoint(value: unknown): NormalizedPoint | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as { x?: unknown; y?: unknown };
  if (typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return {
    x: Math.min(1, Math.max(0, p.x)),
    y: Math.min(1, Math.max(0, p.y)),
  };
}

/** 索引/旧记录里读出来的四角，校验失败返回 null（表示不裁剪） */
export function sanitizeQuad(value: unknown): DocumentQuad | null {
  if (!value || typeof value !== 'object') return null;
  const q = value as Partial<Record<keyof DocumentQuad, unknown>>;
  const topLeft = sanitizePoint(q.topLeft);
  const topRight = sanitizePoint(q.topRight);
  const bottomRight = sanitizePoint(q.bottomRight);
  const bottomLeft = sanitizePoint(q.bottomLeft);
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return null;
  return { topLeft, topRight, bottomRight, bottomLeft };
}

/** 四角是否基本等于整张图——是的话裁剪可以完全跳过 */
export function isFullQuad(quad: DocumentQuad, eps = 0.004): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= eps;
  return (
    near(quad.topLeft.x, 0) &&
    near(quad.topLeft.y, 0) &&
    near(quad.topRight.x, 1) &&
    near(quad.topRight.y, 0) &&
    near(quad.bottomRight.x, 1) &&
    near(quad.bottomRight.y, 1) &&
    near(quad.bottomLeft.x, 0) &&
    near(quad.bottomLeft.y, 1)
  );
}

/**
 * 四边形有效面积（鞋带公式，归一化坐标）。
 * 点顺序乱掉或拖成一条线时面积会塌陷，保存前用它兜底。
 */
export function quadArea(quad: DocumentQuad): number {
  const pts = [
    quad.topLeft,
    quad.topRight,
    quad.bottomRight,
    quad.bottomLeft,
  ];
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** 显示用的最小裁剪面积；再小就当作误触 */
export const MIN_QUAD_AREA = 0.02;
