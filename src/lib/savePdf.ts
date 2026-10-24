import { Platform } from 'react-native';
import { Directory, File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

/**
 * 把已生成的 PDF 交给用户保存。
 *
 * 「保存成 PDF」直觉上应该弹系统保存框，而不是分享面板：
 * - Android：SAF 文件夹选择器（ACTION_OPEN_DOCUMENT_TREE），选完直接把文件
 *   拷进去。不需要存储权限，保存后其他应用也能读到。
 * - iOS：没有等价的「保存到文件夹」流程，系统分享面板里的「存储到“文件”」
 *   就是标准做法。
 *
 * 注意写入要走 expo-file-system 的新 API（File/Directory）：旧 API 的
 * writeAsStringAsync 会用 DocumentFile.canWrite() 校验目标目录，而 Downloads
 * 这类系统 provider 的 canWrite() 恒为 false，会误报「isn't writable」。
 * 新 API 直接交给 ContentResolver 写。
 */
export type SavePdfOutcome =
  /** 用户选好位置，文件已写入（Android） */
  | 'saved'
  /** 已打开系统分享面板（iOS） */
  | 'shared'
  /** 用户取消了位置选择 */
  | 'cancelled'
  /** 设备不支持分享，只能提示文件路径 */
  | 'unavailable';

/** 去掉文件名里不能用的字符，供系统保存框使用 */
export function pdfFileName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || '文档'}.pdf`;
}

/**
 * @param fileUri 沙盒里已生成的 PDF，文件名就是保存后的文件名
 */
export async function savePdfToUser(
  fileUri: string,
): Promise<SavePdfOutcome> {
  if (Platform.OS === 'android') {
    const permissions =
      await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permissions.granted) return 'cancelled';

    // 目标传文件夹：原生拷贝会用源文件名（已按文档标题命名）建文件。
    // overwrite 让同名文件被替换，而不是报 DestinationAlreadyExists。
    const folder = new Directory(permissions.directoryUri);
    await new File(fileUri).copy(folder, { overwrite: true });
    return 'saved';
  }

  const available = await Sharing.isAvailableAsync();
  if (!available) return 'unavailable';
  const name = fileUri.slice(fileUri.lastIndexOf('/') + 1);
  await Sharing.shareAsync(fileUri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: name.replace(/\.pdf$/i, ''),
  });
  return 'shared';
}
