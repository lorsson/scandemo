import type { FilterKey, PageAdjust } from './lib/filters';

// 算法清单与标签集中在 ./lib/filters.ts，这里只做转出，避免两处漂移
export type { FilterKey } from './lib/filters';
export { FILTER_LABELS } from './lib/filters';

export type ScanDoc = {
  id: string;
  title: string;
  /** 扫描页；旧版本的单图扫描会在读取索引时迁移成 1 页 */
  pages: DocPage[];
  createdAt: number;
  updatedAt: number;
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

/**
 * 文档里的一页。PDF 文档和扫描文档共用同一套页面结构。
 * originalUri 永不覆盖，uri 是当前用于显示/生成的版本
 */
export type DocPage = {
  id: string;
  /** 导入时预处理后的原图（缩放到工作尺寸），用于重置/重新编辑 */
  originalUri: string;
  /** 当前效果图；没有编辑时等于 originalUri */
  uri: string;
  /** 220px 左右的列表缩略图 */
  thumbUri: string;
  filter: FilterKey;
  rotation: Rotation;
  /** 第二步微调（对比度 / 亮度 / 细节）；旧记录没有这个字段时按全 0 处理 */
  adjust?: PageAdjust | null;
  /**
   * 预留：ONNX 智能切边建议的四角。
   * 手动/默认四角裁剪会把结果直接烘焙成新的 originalUri，因此这里通常为 null。
   */
  cropQuad?: DocumentQuad | null;
  /** 预留：手动批注数据；当前版本不写入 */
  annotations?: PageAnnotation[];
};

export type PdfDoc = {
  id: string;
  title: string;
  pages: DocPage[];
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
