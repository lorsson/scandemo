import { common } from '@kit.AbilityKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { picker, fileIo as fs } from '@kit.CoreFileKit';
import { router, promptAction } from '@kit.ArkUI';

import { ImageCoreService } from '../image/ImageCoreService';
import { PdfWriter } from '../pdf/PdfWriter';

const FILTER_KEYS: string[] = ['original', 'enhance', 'gray', 'bw'];
const FILTER_LABELS: string[] = ['原图', '增强', '灰度', '黑白'];
/** 与 RN 端一致：页面工作尺寸上限；PDF 里再按 A4 等比缩放 */
const PAGE_MAX_DIM: number = 1600;
const THUMB_WIDTH: number = 220;
/** 鸿蒙端保守上限：逐页处理，内存只与单页有关，主要限制是生成后的文件大小 */
const MAX_PAGES: number = 30;

function filterLabel(filter: string): string {
  const index: number = FILTER_KEYS.indexOf(filter);
  return index >= 0 ? FILTER_LABELS[index] : filter;
}

class PdfPageItem {
  id: string;
  /** 相册图片在缓存目录里的副本，永不修改 */
  sourcePath: string;
  /** 当前算法处理后的 JPEG；生成 PDF 用的就是它 */
  previewPath: string = '';
  thumbPath: string;
  filter: string;

  constructor(id: string, sourcePath: string, thumbPath: string, filter: string) {
    this.id = id;
    this.sourcePath = sourcePath;
    this.thumbPath = thumbPath;
    this.filter = filter;
  }
}

/**
 * 鸿蒙 PDF 排版页。
 *
 * 三种算法入口与 RN 端一致：
 *   1. 顶部选「导入时自动执行」→ 新导入的每张图立即处理；
 *   2. 每行的「滤镜」按钮 → 只改这一页（手动）；
 *   3. 「原图」+ 全部执行 → 恢复所有页面。
 */
@Entry
@Component
struct PdfPage {
  @State pages: PdfPageItem[] = [];
  @State defaultFilter: string = 'enhance';
  @State busy: boolean = false;
  @State status: string = '';

  private workDir: string = '';

  aboutToAppear(): void {
    const context: common.UIAbilityContext =
      getContext(this) as common.UIAbilityContext;
    this.workDir = context.cacheDir + '/pdf-work';
    if (!fs.accessSync(this.workDir)) {
      fs.mkdirSync(this.workDir, true);
    }
  }

  private copyPicked(uri: string, destPath: string): void {
    const src: fs.File = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    const dest: fs.File = fs.openSync(
      destPath,
      fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC
    );
    try {
      fs.copyFileSync(src.fd, dest.fd);
    } finally {
      fs.closeSync(src);
      fs.closeSync(dest);
    }
  }

  private deleteQuietly(path: string): void {
    try {
      if (path !== '' && fs.accessSync(path)) {
        fs.unlinkSync(path);
      }
    } catch (e) {
      // 文件已不存在或被占用：忽略
    }
  }

  /**
   * 从原图重新渲染一页：滤镜在解码阶段顺带降采样（PAGE_MAX_DIM），
   * 旧预览文件删掉，不累积多份 1600 px 图。
   */
  private async renderPage(item: PdfPageItem): Promise<void> {
    const output: string =
      this.workDir + '/view-' + item.id + '-' + item.filter + '.jpg';
    await ImageCoreService.processFile(
      item.sourcePath, output, item.filter, 92, PAGE_MAX_DIM
    );
    const previous: string = item.previewPath;
    item.previewPath = output;
    if (previous !== '' && previous !== output) {
      this.deleteQuietly(previous);
    }
    await ImageCoreService.makeThumbnail(
      output, item.thumbPath, THUMB_WIDTH
    );
  }

  private async pickImages(): Promise<void> {
    if (this.busy) {
      return;
    }
    const remaining: number = MAX_PAGES - this.pages.length;
    if (remaining <= 0) {
      promptAction.showToast({ message: '单份最多 ' + MAX_PAGES + ' 页' });
      return;
    }

    let uris: string[] = [];
    try {
      const options: photoAccessHelper.PhotoSelectOptions =
        new photoAccessHelper.PhotoSelectOptions();
      options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
      options.maxSelectNumber = remaining;
      const photoPicker: photoAccessHelper.PhotoViewPicker =
        new photoAccessHelper.PhotoViewPicker();
      const result: photoAccessHelper.PhotoSelectResult =
        await photoPicker.select(options);
      uris = result.photoUris;
    } catch (e) {
      promptAction.showToast({ message: '选择图片失败：' + String(e) });
      return;
    }
    if (uris.length === 0) {
      return;
    }
    await this.importImages(uris.slice(0, remaining));
  }

  /** 逐张导入：拷贝原图 → 自动算法 → 缩略图。内存里同时只有一张图 */
  private async importImages(uris: string[]): Promise<void> {
    this.busy = true;
    let added: number = 0;
    try {
      for (let i = 0; i < uris.length; i++) {
        this.status = '正在处理 ' + (i + 1).toString() + ' / ' + uris.length.toString();
        const id: string = 'p' + Date.now().toString() + '_' + i.toString();
        const sourcePath: string = this.workDir + '/src-' + id;
        this.copyPicked(uris[i], sourcePath);
        const item: PdfPageItem = new PdfPageItem(
          id,
          sourcePath,
          this.workDir + '/thumb-' + id + '.jpg',
          this.defaultFilter
        );
        try {
          await this.renderPage(item);
          // 单张算法失败退回原图，不让整批导入失败
          this.pages = this.pages.concat([item]);
          added++;
        } catch (e) {
          item.filter = 'original';
          await this.renderPage(item);
          this.pages = this.pages.concat([item]);
          added++;
        }
      }
      promptAction.showToast({ message: '已添加 ' + added.toString() + ' 页' });
    } catch (e) {
      promptAction.showToast({ message: '导入失败：' + String(e) });
    } finally {
      this.busy = false;
      this.status = '';
    }
  }

  /** 单页手动切换算法（原图 → 增强 → 灰度 → 黑白 循环） */
  private async cycleFilter(index: number): Promise<void> {
    if (this.busy || index < 0 || index >= this.pages.length) {
      return;
    }
    const item: PdfPageItem = this.pages[index];
    const current: number = FILTER_KEYS.indexOf(item.filter);
    const next: string = FILTER_KEYS[(current + 1) % FILTER_KEYS.length];
    this.busy = true;
    this.status = '正在应用 ' + filterLabel(next);
    try {
      item.filter = next;
      await this.renderPage(item);
      this.pages = this.pages.slice();
    } catch (e) {
      promptAction.showToast({ message: '应用失败：' + String(e) });
    } finally {
      this.busy = false;
      this.status = '';
    }
  }

  /** 把顶部选中的算法应用到所有已有页面（覆盖单页手动设置） */
  private async applyToAll(): Promise<void> {
    if (this.busy || this.pages.length === 0) {
      return;
    }
    this.busy = true;
    try {
      for (let i = 0; i < this.pages.length; i++) {
        this.status =
          '正在应用 ' + (i + 1).toString() + ' / ' + this.pages.length.toString();
        const item: PdfPageItem = this.pages[i];
        item.filter = this.defaultFilter;
        await this.renderPage(item);
      }
      this.pages = this.pages.slice();
      promptAction.showToast({ message: '已应用到全部页面' });
    } catch (e) {
      promptAction.showToast({ message: '应用失败：' + String(e) });
    } finally {
      this.busy = false;
      this.status = '';
    }
  }

  private move(index: number, delta: number): void {
    if (this.busy) {
      return;
    }
    const target: number = index + delta;
    if (target < 0 || target >= this.pages.length) {
      return;
    }
    const next: PdfPageItem[] = this.pages.slice();
    const temp: PdfPageItem = next[index];
    next[index] = next[target];
    next[target] = temp;
    this.pages = next;
  }

  private remove(index: number): void {
    if (this.busy) {
      return;
    }
    const item: PdfPageItem = this.pages[index];
    this.deleteQuietly(item.sourcePath);
    this.deleteQuietly(item.previewPath);
    this.deleteQuietly(item.thumbPath);
    const next: PdfPageItem[] = [];
    for (let i = 0; i < this.pages.length; i++) {
      if (i !== index) {
        next.push(this.pages[i]);
      }
    }
    this.pages = next;
  }

  /** 生成 PDF → 系统保存对话框。取消保存时缓存文件仍保留在 cacheDir */
  private async generate(): Promise<void> {
    if (this.busy || this.pages.length === 0) {
      return;
    }
    this.busy = true;
    try {
      this.status = '正在写入 PDF';
      const outputPath: string =
        this.workDir + '/document-' + Date.now().toString() + '.pdf';
      const imagePaths: string[] = [];
      for (let i = 0; i < this.pages.length; i++) {
        imagePaths.push(this.pages[i].previewPath);
      }
      const count: number = await PdfWriter.write(imagePaths, outputPath);

      this.status = '请选择保存位置';
      const documentPicker: picker.DocumentViewPicker =
        new picker.DocumentViewPicker(getContext(this) as common.UIAbilityContext);
      const saveOptions: picker.DocumentSaveOptions =
        new picker.DocumentSaveOptions();
      saveOptions.newFileNames = ['扫描文档.pdf'];
      const uris: string[] = await documentPicker.save(saveOptions);
      if (uris.length > 0) {
        const src: fs.File = fs.openSync(outputPath, fs.OpenMode.READ_ONLY);
        const dest: fs.File = fs.openSync(uris[0], fs.OpenMode.READ_WRITE);
        try {
          fs.copyFileSync(src.fd, dest.fd);
        } finally {
          fs.closeSync(src);
          fs.closeSync(dest);
        }
        promptAction.showToast({
          message: 'PDF 已生成：' + count.toString() + ' 页',
        });
      }
    } catch (e) {
      promptAction.showToast({ message: '生成失败：' + String(e) });
    } finally {
      this.busy = false;
      this.status = '';
    }
  }

  @Builder
  filterChip(key: string) {
    Text(filterLabel(key))
      .fontSize(13)
      .fontColor(this.defaultFilter === key ? Color.White : '#333333')
      .backgroundColor(this.defaultFilter === key ? '#2f6bff' : '#f1f2f4')
      .borderRadius(9)
      .padding({ left: 12, right: 12, top: 7, bottom: 7 })
      .margin({ right: 8 })
      .onClick(() => {
        if (!this.busy) {
          this.defaultFilter = key;
        }
      })
  }

  @Builder
  pageRow(item: PdfPageItem, index: number) {
    Row() {
      Image('file://' + item.thumbPath)
        .width(46)
        .height(60)
        .borderRadius(6)
        .objectFit(ImageFit.Cover)
        .backgroundColor('#eceef1')

      Column() {
        Text('第 ' + (index + 1).toString() + ' 页')
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
        Text(filterLabel(item.filter) + '模式')
          .fontSize(11)
          .fontColor('#8a8f99')
          .margin({ top: 4 })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .margin({ left: 10 })

      Button('滤镜')
        .fontSize(11)
        .height(28)
        .margin({ right: 4 })
        .enabled(!this.busy)
        .onClick(() => {
          this.cycleFilter(index);
        })
      Button('↑')
        .fontSize(12)
        .height(28)
        .width(32)
        .margin({ right: 4 })
        .enabled(!this.busy && index > 0)
        .onClick(() => {
          this.move(index, -1);
        })
      Button('↓')
        .fontSize(12)
        .height(28)
        .width(32)
        .margin({ right: 4 })
        .enabled(!this.busy && index < this.pages.length - 1)
        .onClick(() => {
          this.move(index, 1);
        })
      Button('✕')
        .fontSize(12)
        .height(28)
        .width(32)
        .backgroundColor('#fdeeee')
        .fontColor('#d9534f')
        .enabled(!this.busy)
        .onClick(() => {
          this.remove(index);
        })
    }
    .width('100%')
    .padding(8)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .fontSize(13)
          .height(32)
          .backgroundColor('#f1f2f4')
          .fontColor('#333333')
          .onClick(() => {
            router.back();
          })
        Text('图片转 PDF')
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        Text(this.pages.length.toString() + ' 页')
          .fontSize(13)
          .fontColor('#8a8f99')
          .width(44)
          .textAlign(TextAlign.End)
      }
      .width('100%')
      .margin({ bottom: 12 })

      Column() {
        Text('导入时自动执行')
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .width('100%')
        Row() {
          ForEach(FILTER_KEYS, (key: string) => {
            this.filterChip(key)
          }, (key: string) => key)
        }
        .margin({ top: 10 })
        .width('100%')

        Text('新导入的图片会自动套用该算法；每行的「滤镜」可单独修改。')
          .fontSize(11)
          .fontColor('#8a8f99')
          .width('100%')
          .margin({ top: 8 })

        if (this.pages.length > 0) {
          Button(this.defaultFilter === 'original' ? '全部恢复原图' : '对整个文档执行')
            .fontSize(12)
            .height(34)
            .width('100%')
            .margin({ top: 10 })
            .enabled(!this.busy)
            .onClick(() => {
              this.applyToAll();
            })
        }
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding(14)
      .backgroundColor(Color.White)
      .borderRadius(14)
      .margin({ bottom: 12 })

      if (this.pages.length === 0) {
        Column() {
          Text('📄').fontSize(40)
          Text('把照片变成 PDF')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .margin({ top: 10 })
          Text('先选算法，再添加图片：算法会自动执行，之后仍可逐页调整。')
            .fontSize(12)
            .fontColor('#8a8f99')
            .textAlign(TextAlign.Center)
            .margin({ top: 8 })
        }
        .layoutWeight(1)
        .width('100%')
        .justifyContent(FlexAlign.Center)
      } else {
        List({ space: 8 }) {
          ForEach(this.pages, (item: PdfPageItem, index: number) => {
            ListItem() {
              this.pageRow(item, index)
            }
          }, (item: PdfPageItem) => item.id)
        }
        .layoutWeight(1)
        .width('100%')
      }

      if (this.status !== '') {
        Text(this.status)
          .fontSize(12)
          .fontColor('#8a8f99')
          .margin({ top: 8 })
      }

      Row() {
        Button('＋ 添加图片')
          .layoutWeight(1)
          .height(46)
          .fontSize(14)
          .backgroundColor('#f1f2f4')
          .fontColor('#333333')
          .enabled(!this.busy)
          .onClick(() => {
            this.pickImages();
          })
        Button('生成 PDF')
          .layoutWeight(1)
          .height(46)
          .fontSize(14)
          .margin({ left: 10 })
          .enabled(!this.busy && this.pages.length > 0)
          .onClick(() => {
            this.generate();
          })
      }
      .width('100%')
      .margin({ top: 10 })
    }
    .width('100%')
    .height('100%')
    .padding(16)
    .backgroundColor('#f5f6f8')
  }
}
