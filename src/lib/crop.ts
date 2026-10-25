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

/**
 * 自动切边的阈值：太小可能是误检，接近整图说明模型退回了边框，
 * 两种情况都不自动裁，保留原图让用户手动处理。
 */
export const AUTO_QUAD_MIN_AREA = 0.04;
export const AUTO_QUAD_MAX_AREA = 0.995;

/**
 * 四个点按 左上→右上→右下→左下 的顺序是否围成凸四边形。
 * 与 CropOverlay 共用（拖拽时也用同一套判定，避免两处标准不一致）。
 */
export function isQuadConvex(quad: DocumentQuad): boolean {
  const points = [
    quad.topLeft,
    quad.topRight,
    quad.bottomRight,
    quad.bottomLeft,
  ];
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false;
    const current = cross > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return true;
}

/**
 * 自动切边是否值得执行：凸、面积在合理区间、且不是整图。
 * 服务端/端侧结果都经过这一层，避免模型退化的结果破坏原图。
 */
export function isUsableQuad(
  quad: DocumentQuad,
  minArea = AUTO_QUAD_MIN_AREA,
  maxArea = AUTO_QUAD_MAX_AREA,
): boolean {
  if (!isQuadConvex(quad)) return false;
  const area = quadArea(quad);
  return area >= minArea && area <= maxArea;
}

/**
 * 把任意顺序的 4 个点整理成 TL,TR,BR,BL。
 * 用「x+y 最小=左上、最大=右下；x-y 最大=右上、最小=左下」，
 * 对常见的近似轴对齐文档足够稳，且不依赖服务端返回顺序。
 */
export function orderQuadPoints(
  points: readonly NormalizedPoint[],
): DocumentQuad | null {
  if (points.length !== 4) return null;
  if (
    points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  ) {
    return null;
  }

  let topLeft = 0;
  let bottomRight = 0;
  let topRight = 0;
  let bottomLeft = 0;
  for (let i = 1; i < 4; i += 1) {
    const sum = points[i].x + points[i].y;
    const diff = points[i].x - points[i].y;
    if (sum < points[topLeft].x + points[topLeft].y) topLeft = i;
    if (sum > points[bottomRight].x + points[bottomRight].y) bottomRight = i;
    if (diff > points[topRight].x - points[topRight].y) topRight = i;
    if (diff < points[bottomLeft].x - points[bottomLeft].y) bottomLeft = i;
  }

  if (new Set([topLeft, topRight, bottomRight, bottomLeft]).size !== 4) {
    return null;
  }

  return {
    topLeft: { ...points[topLeft] },
    topRight: { ...points[topRight] },
    bottomRight: { ...points[bottomRight] },
    bottomLeft: { ...points[bottomLeft] },
  };
}

/** 服务端像素坐标 → 归一化四角（width/height 是上传图片的尺寸） */
export function quadFromPoints(
  points: readonly { x: number; y: number }[],
  width: number,
  height: number,
): DocumentQuad | null {
  if (!(width > 0) || !(height > 0)) return null;
  const normalized = points.map((p) => ({
    x: Math.min(1, Math.max(0, p.x / width)),
    y: Math.min(1, Math.max(0, p.y / height)),
  }));
  return orderQuadPoints(normalized);
}
