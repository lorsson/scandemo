import { Platform } from 'react-native';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { t } from './i18n';

/**
 * 把已生成的 PDF 交给用户。
 *
 * - Android：默认直接存进 App 自己的「PDF」目录（沙盒 documentDirectory/PDF）。
 *   不弹系统文件夹选择器，点一下「保存成 PDF」就落盘，重复保存同名文件直接覆盖。
 *   需要放到手机里给别人看时，再走 exportPdfToUser 的 SAF 流程。
 * - iOS：没有等价的「保存到文件夹」流程，系统分享面板里的「存储到“文件”」
 *   就是标准做法。
 */
export type SavePdfResult =
  /** 已存进 App 的 PDF 目录（Android 默认路径） */
  | { status: 'saved'; path: string }
  /** 已通过系统文件夹选择器写到手机存储（Android） */
  | { status: 'exported' }
  /** 已打开系统分享面板（iOS） */
  | { status: 'shared' }
  /** 用户取消了文件夹选择 */
  | { status: 'cancelled' }
  /** 设备不支持分享，只能提示文件路径 */
  | { status: 'unavailable' };

/** 去掉文件名里不能用的字符，供系统保存框使用 */
export function pdfFileName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || t('defaultDocumentName')}.pdf`;
}

/** App 内保存 PDF 的目录 */
export function appPdfDir(): Directory {
  return new Directory(Paths.document, 'PDF');
}

export type SavePdfOptions = {
  /**
   * 导出到手机文件夹时，目标里已有同名文件则调用；返回 true 表示覆盖。
   * 存进 App 目录不会问：那是我们自己的文件夹，直接覆盖。
   */
  onConflict?: (name: string) => Promise<boolean> | boolean;
};

/** 取文件名：沙盒路径可能做过百分号编码，和 SAF 里的显示名对齐前先解码 */
function fileNameFromUri(uri: string): string {
  const raw = uri.slice(uri.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 展示给用户的沙盒路径（去掉 file:// 前缀、解码中文） */
function displayPath(uri: string): string {
  const withoutScheme = uri.replace(/^file:\/\//, '');
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

/**
 * SAF 子项的显示名。
 *
 * `File.name` 走的是 `Paths.basename(uri)`，而 SAF 子项的 uri 结尾是文档 ID，
 * 形如 `primary:Download/a.pdf`（树根下的文件甚至是 `primary:a.pdf`），
 * 直接比较永远对不上。这里取 document id 的文件名部分。
 */
function safChildName(uri: string): string {
  const raw = uri.slice(uri.lastIndexOf('/') + 1);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // 保持原样
  }
  const withoutVolume = decoded.slice(decoded.lastIndexOf(':') + 1);
  const slash = withoutVolume.lastIndexOf('/');
  return slash >= 0 ? withoutVolume.slice(slash + 1) : withoutVolume;
}

/**
 * 在 SAF 目录里找同名文件。
 *
 * 有些系统的 provider 根本列不出目录：Android 10 的 DownloadStorageProvider 在
 * 列举时会用 DownloadManager 查一个不存在的列，直接抛
 * `IllegalArgumentException: Invalid column original_mimetype`（同一个错误
 * DocumentsUI 自己打开「下载」也会报）。所以列举必须当可选能力处理。
 */
function findExistingFile(folder: Directory, name: string): File | null {
  let items: (File | Directory)[];
  try {
    items = folder.list();
  } catch {
    return null;
  }
  for (const item of items) {
    if (item instanceof File && safChildName(item.uri) === name) return item;
  }
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 存进 App 自己的 PDF 目录；同名直接覆盖 */
async function saveIntoApp(fileUri: string): Promise<SavePdfResult> {
  const dir = appPdfDir();
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  const target = new File(dir, fileNameFromUri(fileUri));
  await new File(fileUri).copy(target, { overwrite: true });
  return { status: 'saved', path: displayPath(target.uri) };
}

/**
 * 把沙盒里的 PDF 写进用户选中的 SAF 目录。
 *
 * 两条路都不做「列目录 / 查文档」：
 * - 新 API：Directory.createFile → DocumentsContract.createDocument，然后写字节；
 * - legacy：StorageAccessFramework.createFileAsync → createDocument，
 *   writeAsStringAsync → ContentResolver.openOutputStream。
 *
 * 为什么要绕开查询：Android 10 的 DownloadStorageProvider 建下载项时会用
 * DownloadManager 查一个不存在的列，凡是读「下载」目录的调用（列举子项、
 * 读单个文档属性，乃至系统「文件」自己打开「下载」）都会抛
 * `IllegalArgumentException: Invalid column original_mimetype`。
 * 只有 createDocument 和 openOutputStream 这两类调用不受影响。
 */
async function writeIntoFolder(
  folder: Directory,
  folderUri: string,
  name: string,
  sourceUri: string,
): Promise<void> {
  const source = new File(sourceUri);

  // 1) 新 API：createFile 建文档，再用 FileHandle 写字节
  //
  // 这里不能用 file.write()：它开头要 exists()（也就是查一次文档属性），
  // 查不到就当文件不存在、转去 file.create()，而 create() 对 content:// 直接抛
  // "File.create function does not work with SAF content:// uris"。
  // FileHandle 走 openFileDescriptor，不查属性。
  let created: File | null = null;
  let newApiError: unknown = null;
  try {
    created = folder.createFile(name, 'application/pdf');
  } catch (error) {
    newApiError = error;
    console.warn('[savePdf] createFile failed', error);
  }
  if (created) {
    try {
      const bytes = await source.bytes();
      const handle = created.open(FileMode.WriteOnly);
      try {
        await handle.writeBytes(bytes);
      } finally {
        handle.close();
      }
      return;
    } catch (error) {
      newApiError = error;
      // 别在用户目录里留下 0 字节的空壳；删不掉就让下面另建一个
      try {
        created.delete();
      } catch {}
      console.warn('[savePdf] write into SAF file failed', error);
    }
  }

  // 2) legacy SAF：createFileAsync + openOutputStream
  try {
    const targetUri = await FileSystem.StorageAccessFramework.createFileAsync(
      folderUri,
      name,
      'application/pdf',
    );
    await FileSystem.writeAsStringAsync(targetUri, await source.base64(), {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (error) {
    throw new Error(
      `[new] ${messageOf(newApiError)} | [legacy] ${messageOf(error)}`,
    );
  }
}

/**
 * 保存 PDF。
 *
 * Android 直接写进 App 的 PDF 目录，不弹任何选择框；iOS 走分享面板。
 */
export async function savePdfToUser(fileUri: string): Promise<SavePdfResult> {
  if (Platform.OS === 'android') {
    return saveIntoApp(fileUri);
  }

  const available = await Sharing.isAvailableAsync();
  if (!available) return { status: 'unavailable' };
  const name = fileNameFromUri(fileUri);
  await Sharing.shareAsync(fileUri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: name.replace(/\.pdf$/i, ''),
  });
  return { status: 'shared' };
}

/**
 * 另存到手机存储（Android 系统文件夹选择器）。
 *
 * 选中的目录里已有同名文件时会先问是否替换；写入失败通常意味着这个 provider
 * 有问题（见 writeIntoFolder 的注释），由调用方提示用户换个目录。
 */
export async function exportPdfToUser(
  fileUri: string,
  options: SavePdfOptions = {},
): Promise<SavePdfResult> {
  if (Platform.OS !== 'android') {
    return savePdfToUser(fileUri);
  }

  const permissions =
    await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permissions.granted) return { status: 'cancelled' };

  const name = fileNameFromUri(fileUri);
  const existing = findExistingFile(
    new Directory(permissions.directoryUri),
    name,
  );
  if (existing) {
    const replace = options.onConflict ? await options.onConflict(name) : true;
    if (!replace) return { status: 'cancelled' };
    // 先删再写：部分 provider 的 overwrite 只是忽略冲突，会留下旧内容
    try {
      existing.delete();
    } catch {}
  }

  await writeIntoFolder(
    new Directory(permissions.directoryUri),
    permissions.directoryUri,
    name,
    fileUri,
  );
  return { status: 'exported' };
}
