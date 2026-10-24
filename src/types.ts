export type FilterKey = 'original' | 'enhance' | 'gray' | 'bw';

export const FILTER_LABELS: Record<FilterKey, string> = {
  original: '原图',
  enhance: '增强',
  gray: '灰度',
  bw: '黑白',
};

export type ScanDoc = {
  id: string;
  /** 处理后的整图，保存在应用沙盒内 */
  uri: string;
  /** 列表缩略图（demo 中与整图相同） */
  thumbUri: string;
  filter: FilterKey;
  createdAt: number;
  title: string;
};

export type Rotation = 0 | 90 | 180 | 270;

export type NormalizedPoint = {
  /** 0..1，相对原图宽度 */
  x: number;
  /** 0..1，相对原图高度 */
  y: number;
};

export type DocumentQuad = {
  topLeft: NormalizedPoint;
  topRight: NormalizedPoint;
  bottomRight: NormalizedPoint;
  bottomLeft: NormalizedPoint;
};

/** 预留：批注用归一化坐标保存，渲染/导出时再映射到输出图 */
export type PageAnnotation = {
  id: string;
  kind: 'ink' | 'text' | 'highlight';
  color: string;
  /** ink 为折线点，其余类型取首点或边界 */
  points: NormalizedPoint[];
  text?: string;
};

/** PDF 里的一页。originalUri 永不覆盖，uri 是当前用于生成的版本 */
export type PdfPage = {
  id: string;
  /** 导入时预处理后的原图（缩放到工作尺寸），用于重置/重新编辑 */
  originalUri: string;
  /** 当前效果图；没有编辑时等于 originalUri */
  uri: string;
  /** 220px 左右的列表缩略图 */
  thumbUri: string;
  filter: FilterKey;
  rotation: Rotation;
  /** 预留：ONNX 切边后的四角；当前版本不写入 */
  cropQuad?: DocumentQuad | null;
  /** 预留：手动批注数据；当前版本不写入 */
  annotations?: PageAnnotation[];
};

export type PdfDoc = {
  id: string;
  title: string;
  pages: PdfPage[];
  /** 最近一次生成成功的 PDF；为 null 表示还没生成 */
  uri: string | null;
  pageCount: number;
  createdAt: number;
  /** pages 最后一次变化时间 */
  updatedAt: number;
  /** 最近一次成功生成 PDF 的时间 */
  generatedAt: number | null;
  /**
   * 新导入图片自动使用的算法。
   * 'original' 表示导入后不处理；单页仍可在编辑器里手动覆盖。
   */
  defaultFilter: FilterKey;
};
