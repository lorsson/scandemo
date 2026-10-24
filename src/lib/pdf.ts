import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';

import {
  createPdfWithNative,
  isNativePdfAvailable,
} from '../../modules/image-core';
import { throwIfAborted } from './abort';
import { readBase64 } from './imagePipeline';
import { getPdfLimits, type PdfLimits } from './pdfLimits';

/**
 * 页数上限不再是常量：expo-print 的工作方式是「整份 HTML 字符串 →
 * WebView 排版 → 输出 PDF」，所有页面（base64）必须同时存在于内存里，
 * 能放多少页取决于设备内存。上限由 pdfLimits.getPdfLimits() 计算。
 * 想彻底摆脱这个限制，见 docs/EDGE_DETECTION.md §6 的原生流式写入。
 */

/** A4 @ 72 PPI，同时用于 Print 选项和 CSS @page */
export const PDF_PAGE_WIDTH = 595;
export const PDF_PAGE_HEIGHT = 842;

/** BitmapFactory / UIGraphicsPDFRenderer 只接受真实路径，不认 file:// */
function toNativePath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

export type PdfProfile = {
  /** 源图最长边（px） */
  maxDim: number;
  jpegQuality: number;
};

/**
 * 页数越多，单页分辨率越低：把「页数 × 单页 base64」控制在几十 MB 内。
 * 再叠加设备内存给出的 maxDim 上限（低端机整份文档都压在 1200 px）。
 * 这是速度 / 清晰度 / 可支持页数之间的折中，详细计算见设计文档。
 */
export function pdfProfileFor(
  pageCount: number,
  limits: PdfLimits = getPdfLimits(),
): PdfProfile {
  let maxDim: number;
  let jpegQuality: number;
  if (pageCount <= 8) {
    maxDim = 1800;
    jpegQuality = 0.9;
  } else if (pageCount <= 25) {
    maxDim = 1500;
    jpegQuality = 0.86;
  } else {
    maxDim = 1200;
    jpegQuality = 0.82;
  }
  return { maxDim: Math.min(maxDim, limits.maxDim), jpegQuality };
}

export type GeneratePdfOptions = {
  signal?: AbortSignal;
  /** 每读完一页回调一次（读 base64 阶段） */
  onProgress?: (done: number, total: number) => void;
};

export type GeneratePdfResult = {
  uri: string;
  /** 实际写入的页数 */
  pageCount: number;
  /**
   * expo-print 报告的页数。实测会多算 1 页（WebView 的分页估算），
   * 只做参考，真实页数以 pageCount / 打开 PDF 为准。
   */
  numberOfPages: number;
};

/**
 * 逐页读取 base64 并拼接 HTML。
 *
 * 注意：字符串仍然会包含全部页面的 base64，这是 expo-print 的硬限制。
 * 这里能做的只是「一次只读一页」，避免再额外持有所有图片的 ArrayBuffer。
 */
async function buildPdfHtml(
  imageUris: string[],
  options: GeneratePdfOptions,
): Promise<string> {
  let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: ${PDF_PAGE_WIDTH}px ${PDF_PAGE_HEIGHT}px; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  /* 定死成页面大小并裁掉溢出：图片按 max-height 正好填满时，
     亚像素舍入会把每个 section 推到第二页，出现「3 张图 6 页」 */
  .page {
    display: flex;
    align-items: center;
    justify-content: center;
    width: ${PDF_PAGE_WIDTH}px;
    height: ${PDF_PAGE_HEIGHT}px;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
    page-break-inside: avoid;
    break-inside: avoid;
    text-align: center;
    font-size: 0;
    line-height: 0;
  }
  .page:last-child { page-break-after: auto; break-after: auto; }
  img {
    display: block;
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
</style>
</head>
<body>`;

  for (let i = 0; i < imageUris.length; i++) {
    throwIfAborted(options.signal);
    // 一次只把一个文件读成 base64，读完立刻拼进 HTML。
    const base64 = await readBase64(imageUris[i]);
    html += `<section class="page"><img src="data:image/jpeg;base64,${base64}" alt="" /></section>`;
    options.onProgress?.(i + 1, imageUris.length);
  }

  return `${html}</body></html>`;
}

async function ensureParentDir(fileUri: string): Promise<void> {
  const slash = fileUri.lastIndexOf('/');
  if (slash <= 0) return;
  const dir = fileUri.slice(0, slash + 1);
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

async function printHtml(
  html: string,
  withBase64: boolean,
): Promise<Print.FilePrintResult> {
  return Print.printToFileAsync({
    html,
    width: PDF_PAGE_WIDTH,
    height: PDF_PAGE_HEIGHT,
    // base64 会让整份 PDF 额外驻留一次内存，所以只在必须时请求
    base64: withBase64,
  });
}

/**
 * 把 expo-print 的输出搬进应用目录。
 *
 * 同一分区内优先 move（不复制数据），失败再退回 copy。目标文件用
 * `*.tmp` 中转，最后一步才替换旧 PDF，保证重新生成失败时旧文件仍然可用。
 */
async function movePrintedTo(printedUri: string, outputUri: string): Promise<void> {
  const tempUri = `${outputUri}.tmp`;
  await FileSystem.deleteAsync(tempUri, { idempotent: true });
  try {
    try {
      await FileSystem.moveAsync({ from: printedUri, to: tempUri });
    } catch {
      await FileSystem.copyAsync({ from: printedUri, to: tempUri });
    }
    await FileSystem.deleteAsync(outputUri, { idempotent: true });
    await FileSystem.moveAsync({ from: tempUri, to: outputUri });
  } finally {
    await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
    await FileSystem.deleteAsync(printedUri, { idempotent: true }).catch(() => {});
  }
}

/** 写 base64 → 目标文件，同样先写 .tmp 再替换，避免半截 PDF */
async function writeBase64To(base64: string, outputUri: string): Promise<void> {
  const tempUri = `${outputUri}.tmp`;
  try {
    await FileSystem.writeAsStringAsync(tempUri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    await FileSystem.deleteAsync(outputUri, { idempotent: true });
    await FileSystem.moveAsync({ from: tempUri, to: outputUri });
  } finally {
    await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
  }
}

/**
 * 生成 PDF 并写到 outputUri。
 *
 * 先用 expo-print 写到缓存，再原子地替换目标文件：生成失败时旧的 PDF
 * 仍然可用，不会出现「顺序改到一半、PDF 没了」。
 *
 * Expo Go 里 expo-print 的输出位于宿主 App 的缓存目录，而 expo-file-system
 * 在 Expo Go 中只对本项目的沙盒目录放行，因此 move/copy 会报
 * 「Location ... isn't readable」。检测到这种情况时，重新打印一次并让
 * expo-print 直接返回 base64（由我们写入沙盒）。开发/正式构建不会走这条
 * 兜底路径。
 */
export async function generatePdf(
  imageUris: string[],
  outputUri: string,
  options: GeneratePdfOptions = {},
): Promise<GeneratePdfResult> {
  if (imageUris.length === 0) {
    throw new Error('至少需要一张图片');
  }
  const { pageLimit } = getPdfLimits();
  if (imageUris.length > pageLimit) {
    throw new Error(`本机单次最多生成 ${pageLimit} 页`);
  }

  throwIfAborted(options.signal);

  // 原生路径：逐页解码后直接画进 PDF，不经过 HTML / WebView / base64。
  // 几十页也只要几百毫秒，失败时再退回 expo-print。
  if (isNativePdfAvailable()) {
    try {
      await ensureParentDir(outputUri);
      options.onProgress?.(0, imageUris.length);
      const pages = await createPdfWithNative(
        imageUris.map(toNativePath),
        toNativePath(outputUri),
        PDF_PAGE_WIDTH,
        PDF_PAGE_HEIGHT,
      );
      options.onProgress?.(pages, imageUris.length);
      throwIfAborted(options.signal);
      console.log(`[pdf] native done pages=${pages} uri=${outputUri}`);
      return { uri: outputUri, pageCount: pages, numberOfPages: pages };
    } catch (e) {
      if (options.signal?.aborted) throw e;
      console.warn(
        `[pdf] native failed (${(e as Error)?.message ?? e}); falling back to expo-print`,
      );
    }
  }

  const html: string = await buildPdfHtml(imageUris, options);
  throwIfAborted(options.signal);

  await ensureParentDir(outputUri);

  let printed = await printHtml(html, false);
  try {
    await movePrintedTo(printed.uri, outputUri);
  } catch (copyError) {
    // Expo Go 的沙盒限制：让 expo-print 直接给 base64，由 JS 写入沙盒
    console.log(
      `[pdf] cannot copy print output (${(copyError as Error)?.message ?? copyError}); retrying with base64`,
    );
    printed = await printHtml(html, true);
    if (!printed.base64) throw copyError;
    await writeBase64To(printed.base64, outputUri);
  }

  console.log(
    `[pdf] done pages=${printed.numberOfPages} pages-requested=${imageUris.length} uri=${outputUri}`,
  );

  return {
    uri: outputUri,
    pageCount: imageUris.length,
    numberOfPages: printed.numberOfPages,
  };
}
