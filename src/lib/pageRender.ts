import * as FileSystem from 'expo-file-system/legacy';

import { applyFilter, discardFiltered } from './filterRunner';
import { isZeroAdjust, sanitizeAdjust, type PageAdjust } from './filters';
import { readBase64, rotateImage } from './imagePipeline';
import type { DocPage, FilterKey, Rotation } from '../types';

export type PageEditPlan = {
  filter: FilterKey;
  rotation: Rotation;
  /** 第二步微调；不传按全 0 处理 */
  adjust?: PageAdjust | null;
};

/**
 * 从页面原图重新渲染一页，返回 JPEG base64（可直接交给 savePageEdit）。
 *
 * 规则与单页编辑器一致：
 *   originalUri → 旋转 → 滤镜
 * 每次都从 originalUri 开始，不在上一次的结果上叠加编码损失；
 * 中间文件（旋转产物、原生滤镜产物）用完即删。
 *
 * 批量应用算法和「恢复原图」都走这条路径，保证任何入口的结果一致。
 */
export async function renderPageBase64(
  page: DocPage,
  edit: PageEditPlan,
): Promise<string> {
  let workUri = page.originalUri;
  let rotatedUri: string | null = null;
  const adjust = sanitizeAdjust(edit.adjust);

  try {
    if (edit.rotation !== 0) {
      workUri = await rotateImage(page.originalUri, edit.rotation);
      rotatedUri = workUri;
    }

    if (edit.filter === 'original' && isZeroAdjust(adjust)) {
      return await readBase64(workUri);
    }

    const filtered = await applyFilter(workUri, edit.filter, adjust);
    try {
      return filtered.base64 ?? (await readBase64(filtered.uri));
    } finally {
      await discardFiltered(filtered);
    }
  } finally {
    if (rotatedUri) {
      await FileSystem.deleteAsync(rotatedUri, { idempotent: true }).catch(() => {});
    }
  }
}
