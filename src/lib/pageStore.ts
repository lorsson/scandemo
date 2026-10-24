import * as FileSystem from 'expo-file-system/legacy';

import { throwIfAborted } from './abort';
import { sanitizeQuad } from './crop';
import { applyFilter, discardFiltered, writeFiltered } from './filterRunner';
import {
  isFilterKey,
  isZeroAdjust,
  sanitizeAdjust,
  ZERO_ADJUST,
  type PageAdjust,
} from './filters';
import { resizeImage, resizeToWidth } from './imagePipeline';
import type { DocPage, FilterKey, Rotation } from '../types';

/** 列表缩略图的宽度；只用于 UI，避免列表解码 1200–1800px 的源图 */
export const THUMB_WIDTH = 220;

/**
 * 一个文档项目在磁盘上的固定目录结构。
 * PDF 文档（pdfs/<id>/）和扫描文档（scans/<id>/）共用，
 * 页面文件管理逻辑只写一份。
 */
export type PageDirs = {
  root: string;
  /** 导入时预处理后的原图，永不覆盖 */
  source: string;
  /** 列表缩略图 */
  thumb: string;
  /** 滤镜/旋转后的效果图 */
  edited: string;
};

export function pageDirs(root: string): PageDirs {
  return {
    root,
    source: `${root}src/`,
    thumb: `${root}thumb/`,
    edited: `${root}edited/`,
  };
}

async function ensureDir(dir: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

/** 索引里读出来的页面可能来自旧版本，逐字段校验后再用 */
export function sanitizePage(value: unknown): DocPage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<DocPage>;
  if (typeof raw.uri !== 'string' || typeof raw.thumbUri !== 'string') return null;

  const filter: FilterKey = isFilterKey(raw.filter) ? raw.filter : 'original';
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
    adjust: sanitizeAdjust(raw.adjust),
    cropQuad: sanitizeQuad(raw.cropQuad),
    annotations: Array.isArray(raw.annotations) ? raw.annotations : [],
  };
}

export type ImportPagesOptions = {
  /** 单页最长边（px） */
  maxDim: number;
  /** 重新编码的 JPEG 质量 */
  jpegQuality: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /**
   * 新导入页面自动执行的算法；不传或 'original' 表示不改像素。
   * 单张处理失败会退回原图并继续导入，不会让整批失败。
   */
  filter?: FilterKey;
};

/**
 * 把相册里的图片逐张转成页面源图 + 缩略图，存进项目目录。
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
export async function importPages(
  dirs: PageDirs,
  imageUris: string[],
  options: ImportPagesOptions,
): Promise<DocPage[]> {
  const desiredFilter = options.filter ?? 'original';

  await ensureDir(dirs.source);
  await ensureDir(dirs.thumb);
  if (desiredFilter !== 'original') {
    await ensureDir(dirs.edited);
  }

  const created: string[] = [];
  const pages: DocPage[] = [];

  try {
    for (let i = 0; i < imageUris.length; i++) {
      throwIfAborted(options.signal);

      // 统一转成 JPEG：后续缩略图/滤镜/PDF 都按 image/jpeg 处理
      const normalized = await resizeImage(
        imageUris[i],
        options.maxDim,
        options.jpegQuality,
        true,
      );

      const stamp = `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`;
      const pageId = `p_${stamp}`;
      const sourceUri = `${dirs.source}${pageId}.jpg`;
      await FileSystem.copyAsync({ from: normalized, to: sourceUri });
      created.push(sourceUri);

      throwIfAborted(options.signal);

      // 自动算法：输入永远是刚落盘的源图（originalUri），输出写进 edited/
      let pageUri = sourceUri;
      let appliedFilter: FilterKey = 'original';
      if (desiredFilter !== 'original') {
        const editedUri = `${dirs.edited}${pageId}.jpg`;
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
            `[page] auto filter ${desiredFilter} failed for ${sourceUri}: ` +
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

      // 缩略图单独落盘：列表只解码 220px 的小图（原生 C++ 缩放）
      const thumbUri = `${dirs.thumb}${pageId}.jpg`;
      const thumb = await resizeToWidth(pageUri, THUMB_WIDTH, 0.72);
      await FileSystem.copyAsync({ from: thumb, to: thumbUri });
      created.push(thumbUri);

      // 预处理产物在缓存目录，已经拷走，删掉省空间
      if (normalized !== imageUris[i]) {
        await FileSystem.deleteAsync(normalized, { idempotent: true }).catch(() => {});
      }
      await FileSystem.deleteAsync(thumb, { idempotent: true }).catch(() => {});

      pages.push({
        id: pageId,
        originalUri: sourceUri,
        uri: pageUri,
        thumbUri,
        filter: appliedFilter,
        rotation: 0,
        adjust: ZERO_ADJUST,
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
  /** 第二步微调；不传按全 0 处理 */
  adjust?: PageAdjust | null;
};

/** 当前编辑是否需要真正重新编码一版图片 */
export function editNeedsRender(edit: PageEdit): boolean {
  return (
    edit.rotation !== 0 ||
    edit.filter !== 'original' ||
    !isZeroAdjust(edit.adjust)
  );
}

/**
 * 保存单页编辑结果。
 *
 * - base64 为渲染层处理后的 JPEG；filter=original 且未旋转且无微调时可以传 null
 * - 只覆盖 uri/缩略图，originalUri 永远保留，方便再次编辑或恢复原图
 * - 新文件先写、缩略图先写临时文件再替换；失败时保留旧页面
 */
export async function savePageEdit(
  dirs: PageDirs,
  page: DocPage,
  base64: string | null,
  edit: PageEdit,
  options: { signal?: AbortSignal } = {},
): Promise<DocPage> {
  throwIfAborted(options.signal);

  let nextUri = page.originalUri;
  let createdUri: string | null = null;
  let createdThumbUri: string | null = null;
  const adjust = sanitizeAdjust(edit.adjust);

  if (editNeedsRender({ ...edit, adjust })) {
    if (!base64) throw new Error('缺少处理后的图片数据');
    await ensureDir(dirs.edited);
    const target = `${dirs.edited}${page.id}_${Date.now()}.jpg`;
    await FileSystem.writeAsStringAsync(target, base64, {
      encoding: 'base64' as any,
    });
    nextUri = target;
    createdUri = target;
  }

  try {
    throwIfAborted(options.signal);

    // 缩略图 URI 每次保存都换一个：RN/Fresco 按 URI 缓存图片，覆盖同名文件
    // 不会让已经显示过的缩略图刷新，阅读器、排版页和首页封面都会停在旧图上。
    // 新图写成功后再删旧图。
    await ensureDir(dirs.thumb);
    const thumbUri = `${dirs.thumb}${page.id}_${Date.now()}.jpg`;
    const thumb = await resizeToWidth(nextUri, THUMB_WIDTH, 0.72);
    await FileSystem.copyAsync({ from: thumb, to: thumbUri });
    createdThumbUri = thumbUri;
    await FileSystem.deleteAsync(thumb, { idempotent: true }).catch(() => {});

    // 旧的编辑结果不再需要；原图永不删除
    if (page.uri !== page.originalUri && page.uri !== nextUri) {
      await FileSystem.deleteAsync(page.uri, { idempotent: true }).catch(() => {});
    }
    if (page.thumbUri !== thumbUri && page.thumbUri.startsWith(dirs.thumb)) {
      await FileSystem.deleteAsync(page.thumbUri, { idempotent: true }).catch(() => {});
    }

    return {
      ...page,
      uri: nextUri,
      thumbUri,
      filter: edit.filter,
      rotation: edit.rotation,
      adjust,
      cropQuad: page.cropQuad ?? null,
      annotations: page.annotations ?? [],
    };
  } catch (error) {
    if (createdUri) {
      await FileSystem.deleteAsync(createdUri, { idempotent: true }).catch(() => {});
    }
    if (createdThumbUri) {
      await FileSystem.deleteAsync(createdThumbUri, { idempotent: true }).catch(() => {});
    }
    throw error;
  }
}

/**
 * 裁剪完成后把结果升级为新的源图。
 *
 * 裁剪是破坏性操作，和滤镜不同：不能从旧原图重算。因此这里直接写一份新的
 * source 文件，旧原图（包括按它生成的 edited）随页替换一起清理。
 * 旋转在裁剪时已经烘焙进像素，页面状态重置为 rotation=0；
 * 滤镜 / 微调由调用方基于新源图重新渲染。
 */
export async function replacePageSource(
  dirs: PageDirs,
  page: DocPage,
  base64: string,
  options: { signal?: AbortSignal } = {},
): Promise<DocPage> {
  return replacePageSourceWith(
    dirs,
    page,
    async (target) => {
      await FileSystem.writeAsStringAsync(target, base64, {
        encoding: 'base64' as any,
      });
    },
    options,
  );
}

/**
 * 同上，但结果已经在磁盘上（原生 C++ 裁剪直接写文件）。
 * 直接复制，省掉一次 base64 编码 + 解码。
 *
 * sourceUri 必须是 `file://` 开头的 URI——expo-file-system 的 copyAsync
 * 不认裸路径（会报 "No resource found with the name /data/..."）。
 */
export async function replacePageSourceFromFile(
  dirs: PageDirs,
  page: DocPage,
  sourceUri: string,
  options: { signal?: AbortSignal } = {},
): Promise<DocPage> {
  return replacePageSourceWith(
    dirs,
    page,
    async (target) => {
      await FileSystem.copyAsync({ from: sourceUri, to: target });
    },
    options,
  );
}

async function replacePageSourceWith(
  dirs: PageDirs,
  page: DocPage,
  writeSource: (target: string) => Promise<void>,
  options: { signal?: AbortSignal } = {},
): Promise<DocPage> {
  throwIfAborted(options.signal);
  await ensureDir(dirs.source);
  await ensureDir(dirs.thumb);

  const stamp = Date.now();
  const sourceUri = `${dirs.source}${page.id}_crop_${stamp}.jpg`;
  const thumbUri = `${dirs.thumb}${page.id}_${stamp}.jpg`;
  let createdSource = false;
  let createdThumb = false;

  try {
    await writeSource(sourceUri);
    createdSource = true;
    throwIfAborted(options.signal);

    const thumb = await resizeToWidth(sourceUri, THUMB_WIDTH, 0.72);
    await FileSystem.copyAsync({ from: thumb, to: thumbUri });
    createdThumb = true;
    await FileSystem.deleteAsync(thumb, { idempotent: true }).catch(() => {});

    // 旧文件只有在项目目录内才删除，避免误删用户相册里的原图
    if (page.originalUri !== sourceUri && page.originalUri.startsWith(dirs.root)) {
      await FileSystem.deleteAsync(page.originalUri, { idempotent: true }).catch(
        () => {},
      );
    }
    if (
      page.uri !== page.originalUri &&
      page.uri !== sourceUri &&
      page.uri.startsWith(dirs.edited)
    ) {
      await FileSystem.deleteAsync(page.uri, { idempotent: true }).catch(() => {});
    }
    if (page.thumbUri !== thumbUri && page.thumbUri.startsWith(dirs.thumb)) {
      await FileSystem.deleteAsync(page.thumbUri, { idempotent: true }).catch(
        () => {},
      );
    }

    return {
      ...page,
      originalUri: sourceUri,
      uri: sourceUri,
      thumbUri,
      filter: 'original',
      rotation: 0,
      adjust: ZERO_ADJUST,
      cropQuad: null,
    };
  } catch (error) {
    if (createdSource) {
      await FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(() => {});
    }
    if (createdThumb) {
      await FileSystem.deleteAsync(thumbUri, { idempotent: true }).catch(() => {});
    }
    throw error;
  }
}

export async function deletePageFiles(page: DocPage): Promise<void> {
  const uris = new Set([page.originalUri, page.uri, page.thumbUri]);
  await Promise.all(
    [...uris].map((uri) =>
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}),
    ),
  );
}
