import { common } from '@kit.AbilityKit';
import { picker, fileIo as fs } from '@kit.CoreFileKit';

import { PdfWriter } from './PdfWriter';

export interface PdfSaveResult {
  /** 实际写入的页数 */
  count: number;
  /** 用户是否确认了保存位置 */
  saved: boolean;
}

/**
 * 生成 PDF 并交给系统保存对话框。
 *
 * 和 RN 端的 `savePdfToUser()` 行为一致：
 *   1. 先在缓存目录写一份完整 PDF（失败不会污染用户选择的文件）；
 *   2. `DocumentViewPicker.save()` 让用户选目录/文件名；
 *   3. 拷贝过去，成功后再删缓存文件。
 * 用户取消保存时缓存文件保留，方便再次保存。
 */
export async function savePdfToUser(
  context: common.UIAbilityContext,
  imagePaths: string[],
  title: string
): Promise<PdfSaveResult> {
  const outputPath: string = context.cacheDir + '/scan-' + Date.now().toString() + '.pdf';
  const count: number = await PdfWriter.write(imagePaths, outputPath);

  const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
  const saveOptions: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
  const fileName: string = title.endsWith('.pdf') ? title : title + '.pdf';
  saveOptions.newFileNames = [fileName];
  const uris: string[] = await documentPicker.save(saveOptions);
  if (uris.length === 0) {
    return { count: count, saved: false };
  }

  const src: fs.File = fs.openSync(outputPath, fs.OpenMode.READ_ONLY);
  const dest: fs.File = fs.openSync(uris[0], fs.OpenMode.READ_WRITE);
  try {
    fs.copyFileSync(src.fd, dest.fd);
  } finally {
    fs.closeSync(src);
    fs.closeSync(dest);
  }
  try {
    fs.unlinkSync(outputPath);
  } catch (e) {
    // 缓存清理失败不影响结果
  }
  return { count: count, saved: true };
}
