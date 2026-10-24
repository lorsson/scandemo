import { Platform } from 'react-native';
import * as Device from 'expo-device';

/**
 * 单次生成 PDF 的绝对上限。
 *
 * 真正的上限按设备内存计算（见 getPdfLimits）；这个常量只防止异常值
 * 把 HTML 字符串撑到不可收拾。
 */
export const PDF_HARD_MAX_PAGES = 80;

export type PdfLimits = {
  /** 单次最多页数 */
  pageLimit: number;
  /** 单页源图最长边上限（px） */
  maxDim: number;
  /** 设备物理内存（MB），拿不到时为 null */
  totalMB: number | null;
  /** Android JVM 堆上限（MB），其他平台或拿不到时为 null */
  heapMB: number | null;
  source: 'device' | 'fallback';
};

/**
 * 没有设备信息时的保守值。Expo Go / Web 上 Device.totalMemory 可能为空，
 * 此时按「2 GB 低端机」处理，宁可少几页也不要 OOM。
 */
const FALLBACK_LIMITS: PdfLimits = {
  pageLimit: 20,
  maxDim: 1500,
  totalMB: null,
  heapMB: null,
  source: 'fallback',
};

/**
 * 物理内存 → 页数上限。
 *
 * expo-print 生成 PDF 时，整份 HTML（含所有 base64）和 WebView 解码出的
 * 位图要同时驻留内存，峰值大致与页数成正比。按「每 100 MB 物理内存换
 * 1 页」估，再夹在 15–60 之间：2 GB 低端机约 15 页，4 GB 约 35 页，
 * 8 GB 约 60 页。实际值还受 JVM 堆限制，见 heapCap()。
 */
function memoryTier(totalMB: number): number {
  if (totalMB <= 2048) return 15;
  if (totalMB <= 3072) return 25;
  if (totalMB <= 4096) return 35;
  if (totalMB <= 6144) return 50;
  return 60;
}

/**
 * Android 的 Java 堆上限。很多 2–4 GB 机型的 heap 只有 128–256 MB，
 * 大页数会先在 JS 字符串上 OOM，而不是在物理内存上，所以取两者更小值。
 */
function heapCap(heapMB: number): number {
  if (heapMB <= 128) return 10;
  if (heapMB <= 192) return 15;
  if (heapMB <= 256) return 25;
  if (heapMB <= 384) return 35;
  return 60;
}

function maxDimFor(totalMB: number): number {
  if (totalMB <= 2048) return 1200;
  if (totalMB <= 3072) return 1400;
  if (totalMB <= 6144) return 1600;
  return 1800;
}

export function computePdfLimits(
  totalMB: number | null,
  heapMB: number | null,
): PdfLimits {
  if (!totalMB || totalMB <= 0) {
    return { ...FALLBACK_LIMITS, heapMB };
  }

  let pageLimit = memoryTier(totalMB);
  if (heapMB && heapMB > 0) {
    pageLimit = Math.min(pageLimit, heapCap(heapMB));
  }
  pageLimit = Math.max(5, Math.min(PDF_HARD_MAX_PAGES, pageLimit));

  return {
    pageLimit,
    maxDim: maxDimFor(totalMB),
    totalMB,
    heapMB,
    source: 'device',
  };
}

function totalMemoryMB(): number | null {
  const bytes = Device.totalMemory;
  return typeof bytes === 'number' && bytes > 0 ? bytes / (1024 * 1024) : null;
}

let cached: PdfLimits | null = null;

/** 同步读取。尚未 init 时只用物理内存，heap 限制在 initPdfLimits 后生效 */
export function getPdfLimits(): PdfLimits {
  if (!cached) cached = computePdfLimits(totalMemoryMB(), null);
  return cached;
}

/**
 * 启动时调用一次：补上 Android 的 JVM 堆上限，结果缓存到进程结束。
 *
 * getMaxMemoryAsync 只在 Android 上可用，失败时退回只用物理内存，
 * 绝不因为探测失败阻塞启动。
 */
export async function initPdfLimits(): Promise<PdfLimits> {
  let heapMB: number | null = null;
  if (Platform.OS === 'android') {
    try {
      const bytes = await Device.getMaxMemoryAsync();
      if (typeof bytes === 'number' && bytes > 0) heapMB = bytes / (1024 * 1024);
    } catch {
      heapMB = null;
    }
  }
  cached = computePdfLimits(totalMemoryMB(), heapMB);
  return cached;
}
