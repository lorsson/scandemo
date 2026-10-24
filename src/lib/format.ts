import { t } from './i18n';

/**
 * 从图片地址推导默认文档名：取文件名、去掉扩展名。
 * 优先用相册返回的 filename（content:// / ph:// 也能拿到真实名字），
 * 拿不到才退回 URI 最后一段。
 */
export function titleFromUri(
  uri: string,
  fallback = t('defaultScanTitle'),
): string {
  const path = decodeURIComponent(uri.split('?')[0] ?? '');
  const base = path.slice(path.lastIndexOf('/') + 1);
  const name = base.replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  return name || fallback;
}

/** 列表里统一使用的时间格式：2026-10-24 07:26 */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
