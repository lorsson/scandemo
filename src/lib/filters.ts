/**
 * 扫描算法的唯一配置入口。
 *
 * 以后增加/删除算法时只需要：
 *   1. 在 FilterKey 与 FILTER_LABEL_KEYS 里加/删一项（文案加到 i18n.ts）；
 *   2. 在 SCAN_FILTERS 里调整顺序（数组顺序就是界面顺序，删掉即隐藏）；
 *   3. 在 C++（image_core.cpp）与 Canvas（filterEngine.tsx）补同名实现；
 *   4. 各平台桥的 filterId 映射补一行。
 * 界面上不再出现任何写死的算法列表。
 */
import { t, type MessageKey } from './i18n';

export type FilterKey =
  | 'original'
  | 'shadow'
  | 'dehand'
  | 'hd'
  | 'brighten'
  | 'sharpen'
  | 'inksave'
  | 'enhance'
  | 'gray'
  | 'bw'
  | 'invert';

export const FILTER_LABEL_KEYS: Record<FilterKey, MessageKey> = {
  original: 'filterOriginal',
  shadow: 'filterShadow',
  dehand: 'filterDehand',
  hd: 'filterHd',
  brighten: 'filterBrighten',
  sharpen: 'filterSharpen',
  inksave: 'filterInksave',
  enhance: 'filterEnhance',
  gray: 'filterGray',
  bw: 'filterBw',
  invert: 'filterInvert',
};

/** 当前语言下的算法名称（模块级常量会固化语言，所以用函数） */
export function filterLabel(key: FilterKey): string {
  return t(FILTER_LABEL_KEYS[key]);
}

export const FILTER_KEYS = Object.keys(FILTER_LABEL_KEYS) as FilterKey[];

/** 扫描编辑器里展示的算法（顺序即 UI 顺序；删除一项即可隐藏） */
export const SCAN_FILTERS: readonly FilterKey[] = [
  'original',
  'shadow',
  'dehand',
  'hd',
  'brighten',
  'sharpen',
  'inksave',
  'enhance',
  'gray',
  'bw',
  'invert',
];

/** 新导入页面自动套用的算法 */
export const IMPORT_FILTER: FilterKey = 'enhance';

export type AdjustKey = 'contrast' | 'brightness' | 'detail';

export type PageAdjust = {
  /** -50..50 */
  contrast: number;
  /** -50..50 */
  brightness: number;
  /** 0..100，锐化/细节强度 */
  detail: number;
};

export const ZERO_ADJUST: PageAdjust = {
  contrast: 0,
  brightness: 0,
  detail: 0,
};

export const ADJUST_LABEL_KEYS: Record<AdjustKey, MessageKey> = {
  contrast: 'adjustContrast',
  brightness: 'adjustBrightness',
  detail: 'adjustDetail',
};

export function adjustLabel(key: AdjustKey): string {
  return t(ADJUST_LABEL_KEYS[key]);
}

export const ADJUST_KEYS: readonly AdjustKey[] = [
  'contrast',
  'brightness',
  'detail',
];

export const ADJUST_RANGE: Record<AdjustKey, { min: number; max: number }> = {
  contrast: { min: -50, max: 50 },
  brightness: { min: -50, max: 50 },
  detail: { min: 0, max: 100 },
};

export function isFilterKey(value: unknown): value is FilterKey {
  return typeof value === 'string' && value in FILTER_LABEL_KEYS;
}

function clampAdjust(key: AdjustKey, value: unknown): number {
  const { min, max } = ADJUST_RANGE[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 索引里读出来的参数可能来自旧版本或被手改过，统一夹到合法范围 */
export function sanitizeAdjust(value: unknown): PageAdjust {
  const raw = (value ?? {}) as Partial<PageAdjust>;
  return {
    contrast: clampAdjust('contrast', raw.contrast),
    brightness: clampAdjust('brightness', raw.brightness),
    detail: clampAdjust('detail', raw.detail),
  };
}

export function isZeroAdjust(adjust: PageAdjust | null | undefined): boolean {
  return (
    !adjust ||
    (adjust.contrast === 0 && adjust.brightness === 0 && adjust.detail === 0)
  );
}

export function sameAdjust(a: PageAdjust, b: PageAdjust): boolean {
  return (
    a.contrast === b.contrast &&
    a.brightness === b.brightness &&
    a.detail === b.detail
  );
}
