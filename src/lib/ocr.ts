import { orderQuadPoints } from './crop';
import type { NormalizedPoint } from '../types';

/**
 * 文字识别（OCR）的数据模型。
 *
 * 推理可以在服务端（PaddleOCR / PP-OCRv4 ONNX）也可以在端侧，对上层只暴露
 * 归一化坐标 + 文本 + 置信度；换推理后端时 UI 与编辑逻辑不用改。
 */

export type OcrLine = {
  id: string;
  /** 文本框四角，顺序 TL,TR,BR,BL，相对图片宽高的归一化值 */
  box: NormalizedPoint[];
  /** 当前文本（用户可编辑） */
  text: string;
  /** 模型原文，用于「↺ 恢复」和「已改」标记 */
  originalText: string;
  score: number;
};

export type OcrPageStatus = 'pending' | 'running' | 'done' | 'failed';

export type OcrPage = {
  id: string;
  /** 会话目录里的文件序号（page-<slot>.jpg）：裁剪会覆盖这个文件 */
  slot: number;
  /** 落盘到 OCR 工作目录的图片（已转正、已裁剪），结果页显示的也是它 */
  uri: string;
  width: number;
  height: number;
  status: OcrPageStatus;
  lines: OcrLine[];
  error?: string;
};

/** 低于这个置信度的行用橙色标出来，让用户优先校对 */
export const LOW_CONFIDENCE = 0.7;

let seq = 0;

export function ocrId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export type RawOcrLine = {
  points: NormalizedPoint[];
  text: string;
  score: number;
};

/** 服务端一行 → 可编辑行；四角顺序不可辨认时丢弃（极罕见） */
function toLine(raw: RawOcrLine): OcrLine | null {
  const ordered = orderQuadPoints(raw.points);
  if (!ordered) return null;
  const text = raw.text.trim();
  if (!text) return null;
  return {
    id: ocrId('line'),
    box: [
      ordered.topLeft,
      ordered.topRight,
      ordered.bottomRight,
      ordered.bottomLeft,
    ],
    text,
    originalText: text,
    score: Number.isFinite(raw.score) ? raw.score : 0,
  };
}

export function lineBounds(line: OcrLine) {
  const xs = line.box.map((p) => p.x);
  const ys = line.box.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0, cy: (y0 + y1) / 2 };
}

/**
 * 阅读顺序：先按行（垂直重叠的行算同一行），行内从左到右。
 *
 * 检测模型的输出顺序大体是自上而下，但表格/多栏里会出现整段顺序错乱；
 * 排序只影响初始展示，用户改完的文本按这个顺序导出。
 * 行高用中位数，避免个别异常高的框把整页切错。
 */
export function sortReadingOrder(lines: OcrLine[]): OcrLine[] {
  if (lines.length < 2) return lines;
  const heights = lines.map((line) => lineBounds(line).height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 0.02;
  const rowTolerance = Math.max(median * 0.6, 0.008);

  // 先按 y 排，再把 y 相差小于容差的相邻框归成一行，行内按行首 x 排。
  const sorted = [...lines].sort((a, b) => {
    const ba = lineBounds(a);
    const bb = lineBounds(b);
    return ba.cy - bb.cy || ba.x0 - bb.x0;
  });

  const rows: OcrLine[][] = [];
  for (const line of sorted) {
    const bounds = lineBounds(line);
    const row = rows[rows.length - 1];
    if (row) {
      const anchor = lineBounds(row[0]);
      if (Math.abs(bounds.cy - anchor.cy) <= rowTolerance) {
        row.push(line);
        continue;
      }
    }
    rows.push([line]);
  }
  return rows.flatMap((row) => row.sort((a, b) => lineBounds(a).x0 - lineBounds(b).x0));
}

export function buildLines(raw: RawOcrLine[]): OcrLine[] {
  return sortReadingOrder(
    raw.map(toLine).filter((line): line is OcrLine => line !== null),
  );
}

export function isLineEdited(line: OcrLine): boolean {
  return line.text !== line.originalText;
}

export function isLowConfidence(line: OcrLine): boolean {
  return line.score > 0 && line.score < LOW_CONFIDENCE;
}

export function pageText(page: OcrPage): string {
  return page.lines.map((line) => line.text).join('\n');
}

/** 多页导出：页与页之间空一行 */
export function documentText(pages: OcrPage[]): string {
  return pages
    .map((page) => pageText(page).trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
}
