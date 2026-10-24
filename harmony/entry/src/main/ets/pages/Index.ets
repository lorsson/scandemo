import { webview } from '@kit.ArkWeb';
import { router, promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { util } from '@kit.ArkTS';
import imageCore from 'libimage_core.so';

import { FilterTimings, ImageCoreService } from '../image/ImageCoreService';
import { savePdfToUser } from '../pdf/PdfSave';

/**
 * H5 ↔ ArkTS 的请求。H5 只知道「要什么」，具体用哪个原生 API、
 * 文件放哪里，全部在这里决定；算法一律落到共享 C++ 内核。
 */
interface BridgeRequest {
  id: number;
  op: string;
  input?: string;
  filter?: string;
  quality?: number;
  maxDim?: number;
  contrast?: number;
  brightness?: number;
  detail?: number;
  rotation?: number;
  quad?: number[];
  width?: number;
  count?: number;
  paths?: string[];
  title?: string;
  filters?: string[];
  /** false 时不把 JPEG 读成 data URL 回传（非当前页用不到） */
  withData?: boolean;
}

interface ThumbPayload {
  filter: string;
  data: string;
}

interface PagePayload {
  id: string;
  source: string;
  filter: string;
  width: number;
  height: number;
  /** 列表/算法条缩略图（data URL，220 px） */
  thumb: string;
  /** 主预览（data URL，最长边 1400 px） */
  preview: string;
  /** 主预览在沙盒里的路径，导出 PDF / 保存相册时直接用 */
  previewPath: string;
}

interface BridgeResult {
  id: number;
  ok: boolean;
  error?: string;
  version?: string;
  output?: string;
  data?: string;
  path?: string;
  width?: number;
  height?: number;
  timings?: FilterTimings;
  pages?: PagePayload[];
  thumbs?: ThumbPayload[];
  count?: number;
  saved?: boolean;
}

const SCAN_MAX_DIM: number = 1400;
const THUMB_WIDTH: number = 220;
const THUMB_BASE_DIM: number = 260;

/**
 * 注入到 ArkWeb 页面里的 `window.nativeBridge`。
 *
 * 所有 Promise 结果都通过 runJavaScript -> window.__onNativeResult 回推，
 * 不依赖 JS proxy 的返回值（跨语言边界后 Promise 不可靠）。
 * 请求串行执行：图片处理是内存大户，并发解码会把峰值翻几倍。
 */
class NativeBridge {
  controller: webview.WebviewController;
  context: common.UIAbilityContext | undefined = undefined;

  private ready: Promise<void> = Promise.resolve();
  private workDir: string = '';
  private seq: number = 0;
  /** 旋转产物按「源文件|角度」缓存，切页反复旋转不重复解码 */
  private rotateCache: Map<string, string> = new Map<string, string>();

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
  }

  version(): string {
    return imageCore.version();
  }

  dispatch(payload: string): void {
    // 串行队列：前一个任务结束后才处理下一个
    this.ready = this.ready.then(() => this.handle(payload)).catch(() => {});
  }

  private requireContext(): common.UIAbilityContext {
    const context: common.UIAbilityContext | undefined = this.context;
    if (context === undefined) {
      throw new Error('UIAbilityContext 尚未注入');
    }
    return context;
  }

  private ensureWorkDir(): string {
    if (this.workDir === '') {
      const context: common.UIAbilityContext = this.requireContext();
      this.workDir = context.cacheDir + '/scan-work';
      if (!fs.accessSync(this.workDir)) {
        fs.mkdirSync(this.workDir, true);
      }
    }
    return this.workDir;
  }

  private deleteQuietly(path: string): void {
    if (path === '') {
      return;
    }
    try {
      if (fs.accessSync(path)) {
        fs.unlinkSync(path);
      }
    } catch (e) {
      // 已删除/被占用：忽略
    }
  }

  private copyTo(sourceUri: string, destPath: string): void {
    const src: fs.File = fs.openSync(sourceUri, fs.OpenMode.READ_ONLY);
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

  /** 读成 data URL 交给 H5 显示；ArkWeb 不保证能直接加载沙盒 file:// */
  private dataUrl(path: string): string {
    const stat: fs.Stat = fs.statSync(path);
    const size: number = stat.size;
    if (size <= 0) {
      return '';
    }
    const buffer: ArrayBuffer = new ArrayBuffer(size);
    const file: fs.File = fs.openSync(path, fs.OpenMode.READ_ONLY);
    try {
      fs.readSync(file.fd, buffer);
    } finally {
      fs.closeSync(file);
    }
    const helper: util.Base64Helper = new util.Base64Helper();
    return 'data:image/jpeg;base64,' +
      helper.encodeToStringSync(new Uint8Array(buffer));
  }

  private nextId(prefix: string): string {
    this.seq = this.seq + 1;
    return prefix + Date.now().toString() + '_' + this.seq.toString();
  }

  // -------------------------------------------------------------------------
  // 页面导入 / 渲染
  // -------------------------------------------------------------------------

  /**
   * 导入一张图：拷进工作目录 → C++ 缩放到 1400 → 生成预览 + 缩略图。
   * 与 RN 端 importPages 的顺序一致（normalize → 算法 → 缩略图）。
   */
  private async importPage(
    sourceUri: string,
    id: string,
    filter: string
  ): Promise<PagePayload> {
    const dir: string = this.ensureWorkDir();
    const raw: string = dir + '/raw-' + id;
    this.copyTo(sourceUri, raw);
    const sourcePath: string = dir + '/src-' + id + '.jpg';
    try {
      await ImageCoreService.resizeFile(raw, sourcePath, SCAN_MAX_DIM, 92);
    } finally {
      this.deleteQuietly(raw);
    }
    return this.describePage(id, sourcePath, filter);
  }

  private async describePage(
    id: string,
    sourcePath: string,
    filter: string
  ): Promise<PagePayload> {
    const dir: string = this.ensureWorkDir();
    const previewPath: string = dir + '/view-' + id + '-' + filter + '.jpg';
    const timings: FilterTimings = await ImageCoreService.processFile(
      sourcePath, previewPath, filter, 92, SCAN_MAX_DIM
    );
    const thumbPath: string = dir + '/thumb-' + id + '.jpg';
    await ImageCoreService.makeThumbnail(sourcePath, thumbPath, THUMB_WIDTH);
    return {
      id: id,
      source: sourcePath,
      filter: filter,
      width: timings.width,
      height: timings.height,
      thumb: this.dataUrl(thumbPath),
      preview: this.dataUrl(previewPath),
      previewPath: previewPath,
    };
  }

  /** 把内置示例图写进缓存目录，再走普通导入流程 */
  private async importSample(filter: string): Promise<PagePayload[]> {
    const context: common.UIAbilityContext = this.requireContext();
    const dir: string = this.ensureWorkDir();
    const samplePath: string = dir + '/sample.jpg';
    if (!fs.accessSync(samplePath)) {
      const data: Uint8Array = context.resourceManager.getRawFileContentSync('sample.jpg');
      const file: fs.File = fs.openSync(
        samplePath,
        fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC
      );
      try {
        fs.writeSync(file.fd, data.buffer as ArrayBuffer);
      } finally {
        fs.closeSync(file);
      }
    }
    const id: string = this.nextId('p');
    const page: PagePayload = await this.importPage(samplePath, id, filter);
    return [page];
  }

  /** 系统相册多选；最多 count 张 */
  private async pickImages(filter: string, count: number): Promise<PagePayload[]> {
    const options: photoAccessHelper.PhotoSelectOptions =
      new photoAccessHelper.PhotoSelectOptions();
    options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
    options.maxSelectNumber = count > 0 ? count : 1;
    const picker: photoAccessHelper.PhotoViewPicker =
      new photoAccessHelper.PhotoViewPicker();
    const result: photoAccessHelper.PhotoSelectResult = await picker.select(options);
    const uris: string[] = result.photoUris;
    const pages: PagePayload[] = [];
    for (let i = 0; i < uris.length; i++) {
      const id: string = this.nextId('p');
      pages.push(await this.importPage(uris[i], id, filter));
    }
    return pages;
  }

  /** 当前页 + 旋转角对应的原图（旋转产物缓存，切页不重复解码） */
  private async basePath(source: string, rotation: number): Promise<string> {
    const normalized: number = ((rotation % 360) + 360) % 360;
    if (normalized === 0) {
      return source;
    }
    const key: string = source + '|' + normalized.toString();
    const hit: string | undefined = this.rotateCache.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const dir: string = this.ensureWorkDir();
    const out: string = dir + '/rot-' + this.nextId('') + '.jpg';
    await ImageCoreService.rotateFile(source, out, normalized, 95);
    this.rotateCache.set(key, out);
    return out;
  }

  // -------------------------------------------------------------------------
  // 请求分发
  // -------------------------------------------------------------------------

  private async handle(payload: string): Promise<void> {
    let req: BridgeRequest;
    try {
      req = JSON.parse(payload) as BridgeRequest;
    } catch (e) {
      this.post({ id: -1, ok: false, error: 'bad payload: ' + String(e) });
      return;
    }

    try {
      if (req.op === 'version') {
        this.post({ id: req.id, ok: true, version: imageCore.version() });
        return;
      }
      if (req.op === 'sample') {
        const pages: PagePayload[] = await this.importSample(this.filterOf(req, 'enhance'));
        this.post({ id: req.id, ok: true, pages: pages });
        return;
      }
      if (req.op === 'pick') {
        const pages: PagePayload[] = await this.pickImages(
          this.filterOf(req, 'enhance'),
          req.count === undefined ? 1 : req.count
        );
        this.post({ id: req.id, ok: true, pages: pages });
        return;
      }
      if (req.op === 'base') {
        const source: string = this.requireString(req.input, 'input');
        const rotation: number = req.rotation === undefined ? 0 : req.rotation;
        const path: string = await this.basePath(source, rotation);
        this.post({
          id: req.id, ok: true, path: path, output: path,
          data: this.wantsData(req) ? this.dataUrl(path) : '',
        });
        return;
      }
      if (req.op === 'read') {
        // 已经渲染过但当时没回传 data 的页面：只读文件，不重新跑算法
        const input: string = this.requireString(req.input, 'input');
        this.post({ id: req.id, ok: true, path: input, data: this.dataUrl(input) });
        return;
      }
      if (req.op === 'render') {
        const input: string = this.requireString(req.input, 'input');
        const filter: string = this.filterOf(req, 'original');
        const contrast: number = req.contrast === undefined ? 0 : req.contrast;
        const brightness: number = req.brightness === undefined ? 0 : req.brightness;
        const detail: number = req.detail === undefined ? 0 : req.detail;
        const quality: number = req.quality === undefined ? 92 : req.quality;
        const maxDim: number = req.maxDim === undefined ? SCAN_MAX_DIM : req.maxDim;
        // 不做任何像素处理的组合直接复用原图，避免无意义的重编码（与 RN 一致）
        if (filter === 'original' && contrast === 0 && brightness === 0 && detail === 0) {
          this.post({
            id: req.id, ok: true, output: input, path: input,
            data: this.wantsData(req) ? this.dataUrl(input) : '',
          });
          return;
        }
        const dir: string = this.ensureWorkDir();
        const output: string = dir + '/edit-' + this.nextId('') + '.jpg';
        const timings: FilterTimings = await ImageCoreService.processFileEx(
          input, output, filter, quality, contrast, brightness, detail, maxDim
        );
        this.post({
          id: req.id, ok: true, output: output, path: output,
          width: timings.width, height: timings.height,
          timings: timings,
          data: this.wantsData(req) ? this.dataUrl(output) : '',
        });
        return;
      }
      if (req.op === 'thumbs') {
        // 先把整页缩到 260 px，再对同一张小图跑 11 个算法：
        // 与 RN 端「THUMB_BASE_DIM + applyFilter」完全一致的顺序
        const input: string = this.requireString(req.input, 'input');
        const dir: string = this.ensureWorkDir();
        const small: string = dir + '/tbase-' + this.nextId('') + '.jpg';
        await ImageCoreService.resizeFile(input, small, THUMB_BASE_DIM, 90);
        const filters: string[] = req.filters === undefined ? [] : req.filters;
        const thumbs: ThumbPayload[] = [];
        try {
          for (let i = 0; i < filters.length; i++) {
            const out: string = dir + '/t-' + this.nextId('') + '.jpg';
            await ImageCoreService.processFile(small, out, filters[i], 82, 0);
            thumbs.push({ filter: filters[i], data: this.dataUrl(out) });
            this.deleteQuietly(out);
          }
        } finally {
          this.deleteQuietly(small);
        }
        this.post({ id: req.id, ok: true, thumbs: thumbs });
        return;
      }
      if (req.op === 'warp') {
        const input: string = this.requireString(req.input, 'input');
        const quad: number[] = req.quad === undefined ? [] : req.quad;
        if (quad.length !== 8) {
          throw new Error('quad 需要 8 个归一化坐标');
        }
        const dir: string = this.ensureWorkDir();
        const output: string = dir + '/crop-' + this.nextId('') + '.jpg';
        const quality: number = req.quality === undefined ? 92 : req.quality;
        const maxDim: number = req.maxDim === undefined ? 1600 : req.maxDim;
        const timings: FilterTimings = await ImageCoreService.warpFile(
          input, output, quad, quality, maxDim
        );
        this.post({
          id: req.id, ok: true, output: output, path: output,
          width: timings.width, height: timings.height,
          timings: timings,
          data: this.wantsData(req) ? this.dataUrl(output) : '',
        });
        return;
      }
      if (req.op === 'delete') {
        const paths: string[] = req.paths === undefined ? [] : req.paths;
        for (let i = 0; i < paths.length; i++) {
          this.deleteQuietly(paths[i]);
          // 旋转缓存里指向这个文件的项目一起清掉，避免之后返回失效路径
          const stale: string[] = [];
          this.rotateCache.forEach((value: string, key: string) => {
            if (value === paths[i]) {
              stale.push(key);
            }
          });
          for (let j = 0; j < stale.length; j++) {
            this.rotateCache.delete(stale[j]);
          }
        }
        this.post({ id: req.id, ok: true });
        return;
      }
      if (req.op === 'pdf') {
        const paths: string[] = req.paths === undefined ? [] : req.paths;
        if (paths.length === 0) {
          throw new Error('没有可导出的页面');
        }
        const title: string = req.title === undefined ? '扫描文档' : req.title;
        const result = await savePdfToUser(
          this.requireContext(), paths, title
        );
        this.post({
          id: req.id, ok: true, count: result.count, saved: result.saved,
        });
        return;
      }
      if (req.op === 'saveImages') {
        const paths: string[] = req.paths === undefined ? [] : req.paths;
        const saved: number = await this.saveToGallery(paths, this.titleOf(req));
        this.post({ id: req.id, ok: true, count: saved, saved: saved > 0 });
        return;
      }
      this.post({ id: req.id, ok: false, error: 'unknown op: ' + req.op });
    } catch (e) {
      this.post({ id: req.id, ok: false, error: String(e) });
    }
  }

  private titleOf(req: BridgeRequest): string {
    if (req.title !== undefined && req.title !== '') {
      return req.title;
    }
    return '扫描图片';
  }

  /** 只有当前显示的页面需要把 JPEG 读成 data URL，其余页面只拿路径 */
  private wantsData(req: BridgeRequest): boolean {
    return req.withData === undefined ? true : req.withData;
  }

  private filterOf(req: BridgeRequest, fallback: string): string {
    if (req.filter !== undefined && req.filter !== '') {
      return req.filter;
    }
    return fallback;
  }

  private requireString(value: string | undefined, name: string): string {
    if (value === undefined || value === '') {
      throw new Error(name + ' 不能为空');
    }
    return value;
  }

  /**
   * 保存到系统相册：先让系统弹「是否允许创建图片」，
   * 拿到目标 URI 后再把预览文件拷进去（不需要存储权限）。
   */
  private async saveToGallery(paths: string[], title: string): Promise<number> {
    if (paths.length === 0) {
      throw new Error('没有可保存的页面');
    }
    const context: common.UIAbilityContext = this.requireContext();
    const helper: photoAccessHelper.PhotoAccessHelper =
      photoAccessHelper.getPhotoAccessHelper(context);

    const srcUris: string[] = [];
    const configs: photoAccessHelper.PhotoCreationConfig[] = [];
    for (let i = 0; i < paths.length; i++) {
      srcUris.push('file://' + paths[i]);
      const config: photoAccessHelper.PhotoCreationConfig = {
        title: title + '_' + (i + 1).toString(),
        fileNameExtension: 'jpg',
        photoType: photoAccessHelper.PhotoType.IMAGE,
      };
      configs.push(config);
    }

    const destUris: string[] = await helper.showAssetsCreationDialog(srcUris, configs);
    let saved: number = 0;
    for (let i = 0; i < destUris.length && i < paths.length; i++) {
      const src: fs.File = fs.openSync(paths[i], fs.OpenMode.READ_ONLY);
      const dest: fs.File = fs.openSync(destUris[i], fs.OpenMode.READ_WRITE);
      try {
        fs.copyFileSync(src.fd, dest.fd);
        saved = saved + 1;
      } finally {
        fs.closeSync(src);
        fs.closeSync(dest);
      }
    }
    return saved;
  }

  private post(result: BridgeResult): void {
    const script: string =
      'window.__onNativeResult(' + JSON.stringify(result) + ');';
    this.controller.runJavaScript(script).catch(() => {});
  }

  pushReady(): void {
    this.controller.runJavaScript('window.__onNativeReady && window.__onNativeReady();')
      .catch(() => {});
  }
}

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  bridge: NativeBridge = new NativeBridge(this.controller);
  private toastSeen: boolean = false;

  aboutToAppear(): void {
    this.bridge.context = getContext(this) as common.UIAbilityContext;
  }

  build() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Column() {
        Web({ src: $rawfile('index.html'), controller: this.controller })
          .javaScriptProxy({
            object: this.bridge,
            name: 'nativeBridge',
            methodList: ['dispatch', 'version'],
            controller: this.controller,
          })
          .onPageEnd(() => {
            this.bridge.pushReady();
          })
          .width('100%')
          .height('100%')
      }
      .width('100%')
      .height('100%')

      // 悬浮入口：独立的原生 PDF 排版流程（与 H5 编辑器并存）
      Button('批量转 PDF')
        .fontSize(12)
        .height(34)
        .backgroundColor('#ffffffcc')
        .fontColor('#1f2329')
        .margin({ top: 44, right: 14 })
        .onClick(() => {
          router.pushUrl({ url: 'pages/PdfPage' }).catch((error: Error) => {
            if (!this.toastSeen) {
              this.toastSeen = true;
              promptAction.showToast({ message: '打开失败：' + error.message });
            }
          });
        })
    }
    .width('100%')
    .height('100%')
  }
}
