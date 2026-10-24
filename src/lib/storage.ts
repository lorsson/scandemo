import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { isFilterKey } from './filters';
import { t } from './i18n';
import {
  deletePageFiles,
  importPages,
  pageDirs,
  replacePageSource,
  replacePageSourceFromFile,
  sanitizePage,
  savePageEdit,
  type PageEdit,
} from './pageStore';
import type { DocPage, FilterKey, ScanDoc } from '../types';

const INDEX_KEY = 'scans.index.v1';
const ROOT = `${FileSystem.documentDirectory ?? ''}scans/`;

/** 扫描页的工作尺寸，与单页编辑器保持一致 */
export const SCAN_MAX_DIM = 1400;
const SCAN_JPEG_QUALITY = 0.92;

export function scanProjectDir(id: string): string {
  return `${ROOT}${id}/`;
}

function dirs(id: string) {
  return pageDirs(scanProjectDir(id));
}

/**
 * 读取索引。
 *
 * v1 里「一份扫描 = 一张图」（字段 uri/thumbUri/filter），v2 起每份文档有
 * pages 数组。旧记录在这里就地迁移成 1 页，文件路径不变，随时可以删除或查看。
 */
function sanitizeDoc(value: unknown): ScanDoc | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ScanDoc> & {
    uri?: unknown;
    thumbUri?: unknown;
    filter?: unknown;
  };
  if (typeof raw.id !== 'string') return null;

  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();
  let pages: DocPage[] = [];

  if (Array.isArray(raw.pages)) {
    pages = raw.pages
      .map(sanitizePage)
      .filter((page): page is DocPage => page !== null);
  } else if (typeof raw.uri === 'string') {
    const filter: FilterKey = isFilterKey(raw.filter)
      ? raw.filter
      : 'original';
    pages = [
      {
        id: raw.id,
        originalUri: raw.uri,
        uri: raw.uri,
        thumbUri: typeof raw.thumbUri === 'string' ? raw.thumbUri : raw.uri,
        filter,
        rotation: 0,
      },
    ];
  }

  if (pages.length === 0) return null;

  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : t('defaultScanTitle'),
    pages,
    createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt,
  };
}

export async function loadDocs(): Promise<ScanDoc[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeDoc).filter((d): d is ScanDoc => d !== null);
  } catch {
    return [];
  }
}

export async function saveIndex(docs: ScanDoc[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(docs));
}

export type ImportScanOptions = {
  /** 新页面自动执行的算法 */
  filter?: FilterKey;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
};

/** 把相册图片逐张落盘成扫描页（缩放 → 转码 → 自动算法 → 缩略图） */
export function importScanPages(
  docId: string,
  imageUris: string[],
  options: ImportScanOptions = {},
): Promise<DocPage[]> {
  return importPages(dirs(docId), imageUris, {
    maxDim: SCAN_MAX_DIM,
    jpegQuality: SCAN_JPEG_QUALITY,
    ...options,
  });
}

export function saveScanPage(
  docId: string,
  page: DocPage,
  base64: string | null,
  edit: PageEdit,
  options: { signal?: AbortSignal } = {},
): Promise<DocPage> {
  return savePageEdit(dirs(docId), page, base64, edit, options);
}

/**
 * 裁剪结果升级为新的源图（破坏性，旧原图会被清理）。
 * 滤镜 / 微调由调用方基于返回的新页面重新渲染。
 */
export function replaceScanPageSource(
  docId: string,
  page: DocPage,
  base64: string,
  options: { signal?: AbortSignal } = {},
): Promise<DocPage> {
  return replacePageSource(dirs(docId), page, base64, options);
}

/** 同上，但裁剪结果已经是磁盘上的文件（原生 C++ 裁剪）；传 file:// URI */
export function replaceScanPageSourceFromFile(
  docId: string,
  page: DocPage,
  sourceUri: string,
  options: { signal?: AbortSignal } = {},
): Promise<DocPage> {
  return replacePageSourceFromFile(dirs(docId), page, sourceUri, options);
}

/**
 * 删除整份扫描文档：先删每页的文件（旧版单图记录的图片不在文档目录里），
 * 再删目录。文件删除失败不影响索引清理。
 */
export async function removeScanDoc(doc: ScanDoc): Promise<void> {
  await Promise.all(doc.pages.map((page) => deletePageFiles(page)));
  await discardScanDraft(doc.id);
}

/** 未保存的草稿：所有页面文件都在文档目录里，直接删目录即可 */
export async function discardScanDraft(docId: string): Promise<void> {
  await FileSystem.deleteAsync(scanProjectDir(docId), { idempotent: true }).catch(
    () => {},
  );
}
