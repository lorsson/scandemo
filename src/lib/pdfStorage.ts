import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { isFilterKey } from './filters';
import {
  deletePageFiles,
  importPages,
  pageDirs,
  sanitizePage,
  savePageEdit as savePageEditIn,
  type PageEdit,
} from './pageStore';
import type { PdfProfile } from './pdf';
import type { DocPage, FilterKey, PdfDoc } from '../types';

const INDEX_KEY = 'pdfs.index.v1';
const ROOT = `${FileSystem.documentDirectory ?? ''}pdfs/`;

export function pdfProjectDir(id: string): string {
  return `${ROOT}${id}/`;
}

export function pdfFilePath(id: string): string {
  return `${pdfProjectDir(id)}document.pdf`;
}

/** 页面文件都在项目目录下，目录结构与扫描文档一致（见 pageStore） */
function dirs(id: string) {
  return pageDirs(pdfProjectDir(id));
}

function sanitizeDoc(value: unknown): PdfDoc | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PdfDoc>;
  if (typeof raw.id !== 'string' || !Array.isArray(raw.pages)) return null;

  const pages = raw.pages
    .map(sanitizePage)
    .filter((p): p is DocPage => p !== null);
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();
  const defaultFilter: FilterKey = isFilterKey(raw.defaultFilter)
    ? raw.defaultFilter
    : 'original';

  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : 'PDF 文档',
    pages,
    uri: typeof raw.uri === 'string' ? raw.uri : null,
    pageCount: pages.length,
    createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt,
    generatedAt: typeof raw.generatedAt === 'number' ? raw.generatedAt : null,
    defaultFilter,
  };
}

export async function loadPdfs(): Promise<PdfDoc[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeDoc).filter((d): d is PdfDoc => d !== null);
  } catch {
    return [];
  }
}

export async function savePdfIndex(pdfs: PdfDoc[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(pdfs));
}

export type PersistPagesOptions = {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  filter?: FilterKey;
};

/** 把相册图片导入 PDF 项目：逐张缩放/转码/套算法/生成缩略图 */
export function persistPdfPages(
  projectId: string,
  imageUris: string[],
  profile: PdfProfile,
  options: PersistPagesOptions = {},
): Promise<DocPage[]> {
  return importPages(dirs(projectId), imageUris, {
    maxDim: profile.maxDim,
    jpegQuality: profile.jpegQuality,
    ...options,
  });
}

export function savePageEdit(
  projectId: string,
  page: DocPage,
  base64: string | null,
  edit: PageEdit,
  options: { signal?: AbortSignal } = {},
): Promise<DocPage> {
  return savePageEditIn(dirs(projectId), page, base64, edit, options);
}

export const deletePdfPageFiles = deletePageFiles;

/** 删除整个项目（PDF + 源图 + 缩略图） */
export async function removePdfProject(id: string, fallbackUri?: string | null): Promise<void> {
  await FileSystem.deleteAsync(pdfProjectDir(id), { idempotent: true }).catch(() => {});
  if (fallbackUri) {
    await FileSystem.deleteAsync(fallbackUri, { idempotent: true }).catch(() => {});
  }
}
