import AsyncStorage from '@react-native-async-storage/async-storage';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

import { throwIfAborted } from './abort';
import { applyFilter, discardFiltered, writeFiltered } from './filterRunner';
import { resizeImage } from './imagePipeline';
import type { PdfProfile } from './pdf';
import type { FilterKey, PdfDoc, PdfPage, Rotation } from '../types';

const INDEX_KEY = 'pdfs.index.v1';
const ROOT = `${FileSystem.documentDirectory ?? ''}pdfs/`;

/** 列表缩略图的宽度；只用于 UI，避免 FlatList 解码 1200–1800px 的源图 */
const THUMB_WIDTH = 220;

export function pdfProjectDir(id: string): string {
  return `${ROOT}${id}/`;
}

export function pdfSourceDir(id: string): string {
  return `${pdfProjectDir(id)}src/`;
}

export function pdfThumbDir(id: string): string {
  return `${pdfProjectDir(id)}thumb/`;
}

function pdfEditedDir(id: string): string {
  return `${pdfProjectDir(id)}edited/`;
}

export function pdfFilePath(id: string): string {
  return `${pdfProjectDir(id)}document.pdf`;
}

async function ensureDir(dir: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

function sanitizePage(value: unknown): PdfPage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PdfPage>;
  if (typeof raw.uri !== 'string' || typeof raw.thumbUri !== 'string') return null;

  const filter: FilterKey =
    raw.filter === 'enhance' || raw.filter === 'gray' || raw.filter === 'bw'
      ? raw.filter
      : 'original';
  const rotation: Rotation =
    raw.rotation === 90 || raw.rotation === 180 || raw.rotation === 270
      ? raw.rotation
      : 0;

  return {
    id: typeof raw.id === 'string' ? raw.id : raw.uri,
    originalUri:
      typeof raw.originalUri === 'string' ? raw.originalUri : raw.uri,
    uri: raw.uri,
    thumbUri: raw.thumbUri,
    filter,
    rotation,
    cropQuad: raw.cropQuad ?? null,
    annotations: Array.isArray(raw.annotations) ? raw.annotations : [],
  };
}

function sanitizeDoc(value: unknown): PdfDoc | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PdfDoc>;
  if (typeof raw.id !== 'string' || !Array.isArray(raw.pages)) return null;

  const pages = raw.pages
    .map(sanitizePage)
    .filter((p): p is PdfPage => p !== null);
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();
  const defaultFilter: FilterKey =
    raw.defaultFilter === 'enhance' ||
    raw.defaultFilter === 'gray' ||
    raw.defaultFilter === 'bw'
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
  /**
   * 新导入页面自动执行的算法；不传或 'original' 表示不改像素。
   * 单张处理失败会退回原图并继续导入，不会让整批失败。
   */
  filter?: FilterKey;
};

/**
 * 把相册里的图片逐张转成 PDF 源图 + 缩略图，存进项目目录。
 *
 * 关键点：全程一次只处理一张图——
 *   相册原图 → 缩放到 maxDim 并转 JPEG → 拷进项目目录
 *   → [自动算法] → 生成缩略图 → 释放引用
 * 峰值内存与图片总数无关，只与「当前这一张 + 缩略图」有关。
 *
 * 自动算法在源图落盘后执行，结果写进 edited/<pageId>.jpg：
 * originalUri 始终是未处理的源图，随时可以重跑或恢复。
 *
 * 中途取消/失败会删掉本次已经写入的所有文件，不留下半套页面。
 */
export async function persistPdfPages(
  projectId: string,
  imageUris: string[],
  profile: PdfProfile,
  options: PersistPagesOptions = {},
): Promise<PdfPage[]> {
  const desiredFilter = options.filter ?? 'original';

  await ensureDir(pdfSourceDir(projectId));
  await ensureDir(pdfThumbDir(projectId));
  if (desiredFilter !== 'original') {
    await ensureDir(pdfEditedDir(projectId));
  }

  const created: string[] = [];
  const pages: PdfPage[] = [];

  try {
    for (let i = 0; i < imageUris.length; i++) {
      throwIfAborted(options.signal);

      // 统一转成 JPEG：PDF 的 data URI 固定按 image/jpeg 写
      const normalized = await resizeImage(
        imageUris[i],
        profile.maxDim,
        profile.jpegQuality,
        true,
      );

      const stamp = `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`;
      const pageId = `p_${stamp}`;
      const sourceUri = `${pdfSourceDir(projectId)}${pageId}.jpg`;
      await FileSystem.copyAsync({ from: normalized, to: sourceUri });
      created.push(sourceUri);

      throwIfAborted(options.signal);

      // 自动算法：输入永远是刚落盘的源图（originalUri），输出写进 edited/
      let pageUri = sourceUri;
      let appliedFilter: FilterKey = 'original';
      if (desiredFilter !== 'original') {
        const editedUri = `${pdfEditedDir(projectId)}${pageId}.jpg`;
        let filtered = null as Awaited<ReturnType<typeof applyFilter>> | null;
        try {
          filtered = await applyFilter(sourceUri, desiredFilter);
          await writeFiltered(filtered, editedUri);
          created.push(editedUri);
          pageUri = editedUri;
          appliedFilter = desiredFilter;
        } catch (error) {
          // 单张失败退回原图：整批导入不因为一张坏图失败
          console.warn(
            `[pdf] auto filter ${desiredFilter} failed for ${sourceUri}: ` +
              `${(error as Error)?.message ?? error}`,
          );
          await FileSystem.deleteAsync(editedUri, { idempotent: true }).catch(
            () => {},
          );
          pageUri = sourceUri;
          appliedFilter = 'original';
        } finally {
          await discardFiltered(filtered);
        }
      }

      throwIfAborted(options.signal);

      // 缩略图单独落盘：列表只解码 220px 的小图
      const thumb = await manipulateAsync(
        pageUri,
        [{ resize: { width: THUMB_WIDTH } }],
        { compress: 0.72, format: SaveFormat.JPEG },
      );
      const thumbUri = `${pdfThumbDir(projectId)}${pageId}.jpg`;
      await FileSystem.copyAsync({ from: thumb.uri, to: thumbUri });
      created.push(thumbUri);

      // 预处理产物在缓存目录，已经拷走，删掉省空间
      if (normalized !== imageUris[i]) {
        await FileSystem.deleteAsync(normalized, { idempotent: true }).catch(() => {});
      }
      await FileSystem.deleteAsync(thumb.uri, { idempotent: true }).catch(() => {});

      pages.push({
        id: pageId,
        originalUri: sourceUri,
        uri: pageUri,
        thumbUri,
        filter: appliedFilter,
        rotation: 0,
        cropQuad: null,
        annotations: [],
      });
      options.onProgress?.(i + 1, imageUris.length);
    }
    return pages;
  } catch (error) {
    await Promise.all(
      created.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})),
    );
    throw error;
  }
}

export type PageEdit = {
  filter: FilterKey;
  rotation: Rotation;
};

/**
 * 保存单页编辑结果。
 *
 * - base64 为 EditorScreen 处理后的 JPEG；filter=original 且未旋转时可以传 null
 * - 只覆盖 uri/缩略图，originalUri 永远保留，方便再次编辑或恢复原图
 * - 新文件先写、缩略图先写临时文件再替换；失败时保留旧页面
 */
export async function savePageEdit(
  projectId: string,
  page: PdfPage,
  base64: string | null,
  edit: PageEdit,
  options: { signal?: AbortSignal } = {},
): Promise<PdfPage> {
  throwIfAborted(options.signal);

  let nextUri = page.originalUri;
  let createdUri: string | null = null;

  if (edit.filter !== 'original' || edit.rotation !== 0) {
    if (!base64) throw new Error('缺少处理后的图片数据');
    await ensureDir(pdfEditedDir(projectId));
    const target = `${pdfEditedDir(projectId)}${page.id}_${Date.now()}.jpg`;
    await FileSystem.writeAsStringAsync(target, base64, {
      encoding: 'base64' as any,
    });
    nextUri = target;
    createdUri = target;
  }

  try {
    throwIfAborted(options.signal);

    // 缩略图路径固定为 page.id，便于覆盖；先写临时文件，成功后再替换
    await ensureDir(pdfThumbDir(projectId));
    const thumb = await manipulateAsync(
      nextUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: 0.72, format: SaveFormat.JPEG },
    );
    const thumbUri = `${pdfThumbDir(projectId)}${page.id}.jpg`;
    const tempThumbUri = `${thumbUri}.tmp`;
    await FileSystem.deleteAsync(tempThumbUri, { idempotent: true }).catch(() => {});
    await FileSystem.copyAsync({ from: thumb.uri, to: tempThumbUri });
    await FileSystem.deleteAsync(thumbUri, { idempotent: true });
    await FileSystem.moveAsync({ from: tempThumbUri, to: thumbUri });
    await FileSystem.deleteAsync(thumb.uri, { idempotent: true }).catch(() => {});

    // 旧的编辑结果不再需要；原图永不删除
    if (page.uri !== page.originalUri && page.uri !== nextUri) {
      await FileSystem.deleteAsync(page.uri, { idempotent: true }).catch(() => {});
    }

    return {
      ...page,
      uri: nextUri,
      thumbUri,
      filter: edit.filter,
      rotation: edit.rotation,
      cropQuad: page.cropQuad ?? null,
      annotations: page.annotations ?? [],
    };
  } catch (error) {
    if (createdUri) {
      await FileSystem.deleteAsync(createdUri, { idempotent: true }).catch(() => {});
    }
    throw error;
  }
}

export async function deletePdfPageFiles(page: PdfPage): Promise<void> {
  const uris = new Set([page.originalUri, page.uri, page.thumbUri]);
  await Promise.all(
    [...uris].map((uri) =>
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}),
    ),
  );
}

/** 删除整个项目（PDF + 源图 + 缩略图） */
export async function removePdfProject(id: string, fallbackUri?: string | null): Promise<void> {
  await FileSystem.deleteAsync(pdfProjectDir(id), { idempotent: true }).catch(() => {});
  if (fallbackUri) {
    await FileSystem.deleteAsync(fallbackUri, { idempotent: true }).catch(() => {});
  }
}
