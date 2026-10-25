import { webview } from '@kit.ArkWeb';
import { router, promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { http } from '@kit.NetworkKit';
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
  /** 文档识别服务地址（与 RN 端「我的 → 文档识别服务」同一个契约） */
  serverUrl?: string;
}

interface DetectPoint {
  x: number;
  y: number;
}

interface DetectResponse {
  code?: number;
  message?: string;
  data?: DetectData;
}

interface DetectData {
  points?: DetectPoint[];
}

interface ThumbPayload {
  filter: string;
  data: string;
}

/** 服务端 OCR 的一行：points 是上传图上的 4 个像素坐标 */
interface OcrRawLine {
  points?: number[][];
  text?: string;
  score?: number;
}

interface OcrData {
  width?: number;
  height?: number;
  lines?: OcrRawLine[];
}

interface OcrResponse {
  code?: number;
  message?: string;
  data?: OcrData;
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
  /** detect 的结果：8 个归一化坐标 TL,TR,BR,BL（相对上传图），识别不到为 null */
  quad?: number[] | null;
  /** ping 的结果：能收到任意 HTTP 响应即为 true */
  reachable?: boolean;
  /** ocr 的结果：按阅读顺序拼好的整页文本 */
  text?: string;
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

  /** 读文件并 base64 编码；空文件返回空串 */
  private fileBase64(path: string): string {
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
    return helper.encodeToStringSync(new Uint8Array(buffer));
  }

  /** 读成 data URL 交给 H5 显示；ArkWeb 不保证能直接加载沙盒 file:// */
  private dataUrl(path: string): string {
    const base64: string = this.fileBase64(path);
    return base64 === '' ? '' : 'data:image/jpeg;base64,' + base64;
  }

  /** 设置页的连通性测试：任何 HTTP 响应都算可达 */
  private async pingServer(serverUrl: string): Promise<boolean> {
    if (serverUrl === '') {
      return false;
    }
    const request: http.HttpRequest = http.createHttp();
    try {
      await request.request(serverUrl.replace(/\/+$/, '') + '/api/edgeDetector', {
        method: http.RequestMethod.GET,
        connectTimeout: 3000,
        readTimeout: 3000,
        expectDataType: http.HttpDataType.STRING,
      });
      return true;
    } catch (e) {
      return false;
    } finally {
      request.destroy();
    }
  }

  /**
   * 调服务端 model_1228 识别四角（与 RN 端 detectionServer.ts 同一契约）。
   * 服务端不可达/超时/返回整图四角时返回 null，H5 继续让用户手动拖。
   */
  private async detectOnServer(
    input: string,
    serverUrl: string
  ): Promise<number[] | null> {
    const dir: string = this.ensureWorkDir();
    const small: string = dir + '/det-' + this.nextId('') + '.jpg';
    try {
      // 上传前压到 1280：服务端输入是 512，传原图只会拖慢上传
      const timings: FilterTimings =
        await ImageCoreService.resizeFile(input, small, 1280, 90);
      const base64: string = this.fileBase64(small);
      if (base64 === '') {
        return null;
      }
      const request: http.HttpRequest = http.createHttp();
      try {
        const url: string = serverUrl.replace(/\/+$/, '') + '/api/edgeDetector';
        const response: http.HttpResponse = await request.request(url, {
          method: http.RequestMethod.POST,
          header: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          extraData: JSON.stringify({ image: base64 }),
          connectTimeout: 4000,
          readTimeout: 4000,
          expectDataType: http.HttpDataType.STRING,
        });
        if (response.responseCode !== 200 || typeof response.result !== 'string') {
          return null;
        }
        const body: DetectResponse = JSON.parse(response.result as string) as DetectResponse;
        const points: DetectPoint[] | undefined = body.data?.points;
        if (body.code !== 200 || points === undefined || points.length !== 4) {
          return null;
        }
        const quad: number[] = [];
        for (let i = 0; i < 4; i++) {
          const nx: number = points[i].x / timings.width;
          const ny: number = points[i].y / timings.height;
          quad.push(Math.min(1, Math.max(0, nx)));
          quad.push(Math.min(1, Math.max(0, ny)));
        }
        return quad;
      } finally {
        request.destroy();
      }
    } catch (e) {
      // 超时/网络错误：退回手动裁剪，不让整条流程失败
      return null;
    } finally {
      this.deleteQuietly(small);
    }
  }

  /**
   * 服务端 OCR（与 RN 端 ocrServer.ts 同一契约）：`POST /api/ocr`
   * 请求 `{ image: base64 }`，返回 `{ data: { width, height, lines } }`，
   * points 是上传图像素坐标。鸿蒙端还没有端侧模型，所以只能走服务端。
   *
   * 行按「先分行、行内从左到右」拼成整页文本，与 RN 的 readingRows 同口径；
   * 网络/服务错误向上抛，让 H5 提示「识别失败」，不要伪装成「没有文字」。
   */
  private async ocrOnServer(input: string, serverUrl: string): Promise<string> {
    const dir: string = this.ensureWorkDir();
    const small: string = dir + '/ocr-' + this.nextId('') + '.jpg';
    try {
      // 预览图本来就压到 1400 长边，这里只统一成 JPEG q90（不放大）
      const timings: FilterTimings =
        await ImageCoreService.resizeFile(input, small, 1600, 90);
      const base64: string = this.fileBase64(small);
      if (base64 === '') {
        throw new Error('读取图片失败');
      }
      const request: http.HttpRequest = http.createHttp();
      try {
        const url: string = serverUrl.replace(/\/+$/, '') + '/api/ocr';
        const response: http.HttpResponse = await request.request(url, {
          method: http.RequestMethod.POST,
          header: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          extraData: JSON.stringify({ image: base64 }),
          connectTimeout: 5000,
          // 90 行文字在桌面 CPU 上也要 6s，冷启动建模型更久
          readTimeout: 60000,
          expectDataType: http.HttpDataType.STRING,
        });
        if (response.responseCode !== 200 || typeof response.result !== 'string') {
          throw new Error('HTTP ' + response.responseCode);
        }
        const body: OcrResponse = JSON.parse(response.result as string) as OcrResponse;
        if (body.code !== 200) {
          throw new Error(body.message === undefined ? '服务端返回错误' : body.message);
        }
        const raw: OcrRawLine[] =
          body.data === undefined || body.data.lines === undefined ? [] : body.data.lines;
        const width: number =
          body.data === undefined || body.data.width === undefined
            ? timings.width
            : body.data.width;
        const height: number =
          body.data === undefined || body.data.height === undefined
            ? timings.height
            : body.data.height;
        return this.readingText(raw, width, height);
      } finally {
        request.destroy();
      }
    } finally {
      this.deleteQuietly(small);
    }
  }

  /** 按行分组（垂直中心相近的算一行），行内从左到右，行间换行 */
  private readingText(raw: OcrRawLine[], width: number, height: number): string {
    const boxes: number[][] = [];
    const texts: string[] = [];
    const heights: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const points: number[][] | undefined = raw[i].points;
      const rawText: string | undefined = raw[i].text;
      const text: string = rawText === undefined ? '' : rawText.trim();
      if (points === undefined || points.length !== 4 || text === '') {
        continue;
      }
      let x0: number = points[0][0] / width;
      let y0: number = points[0][1] / height;
      let x1: number = x0;
      let y1: number = y0;
      for (let j = 1; j < 4; j++) {
        const x: number = points[j][0] / width;
        const y: number = points[j][1] / height;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      boxes.push([x0, y0, x1, y1]);
      texts.push(text);
      heights.push(y1 - y0);
    }
    if (boxes.length === 0) {
      return '';
    }

    const order: number[] = [];
    for (let i = 0; i < boxes.length; i++) {
      order.push(i);
    }
    order.sort((a: number, b: number) => {
      const ca: number = (boxes[a][1] + boxes[a][3]) / 2;
      const cb: number = (boxes[b][1] + boxes[b][3]) / 2;
      return ca === cb ? boxes[a][0] - boxes[b][0] : ca - cb;
    });

    // 行高取中位数：标题和正文差别大，用平均会被标题带偏
    const sortedHeights: number[] = heights.slice().sort((a: number, b: number) => a - b);
    const median: number = sortedHeights[Math.floor(sortedHeights.length / 2)] || 0.02;
    const tolerance: number = Math.max(0.008, median * 0.6);

    // 与 src/lib/ocr.ts 的 readingRows 同口径：和「行的第一行」比中心，
    // 不用滚动平均值（会越并越偏）；竖排框不并进横向的行。
    const rows: number[][] = [];
    for (let i = 0; i < order.length; i++) {
      const index: number = order[i];
      const box: number[] = boxes[index];
      const center: number = (box[1] + box[3]) / 2;
      const horizontal: boolean = (box[2] - box[0]) >= (box[3] - box[1]);
      let merged: boolean = false;
      if (rows.length > 0 && horizontal) {
        const row: number[] = rows[rows.length - 1];
        const anchorBox: number[] = boxes[row[0]];
        const anchor: number = (anchorBox[1] + anchorBox[3]) / 2;
        let rowHorizontal: boolean = true;
        for (let k = 0; k < row.length; k++) {
          const member: number[] = boxes[row[k]];
          if ((member[2] - member[0]) < (member[3] - member[1])) {
            rowHorizontal = false;
            break;
          }
        }
        merged = Math.abs(center - anchor) <= tolerance && rowHorizontal;
      }
      if (merged) {
        rows[rows.length - 1].push(index);
      } else {
        rows.push([index]);
      }
    }

    const lines: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      lines.push(this.rowText(rows[i], boxes, texts));
    }
    return lines.join('\n');
  }

  private rowText(row: number[], boxes: number[][], texts: string[]): string {
    const sorted: number[] = row.slice();
    sorted.sort((a: number, b: number) => boxes[a][0] - boxes[b][0]);
    let text: string = '';
    for (let i = 0; i < sorted.length; i++) {
      text = text === '' ? texts[sorted[i]] : text + ' ' + texts[sorted[i]];
    }
    return text;
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
      if (req.op === 'ping') {
        const serverUrl: string = req.serverUrl === undefined ? '' : req.serverUrl.trim();
        const reachable: boolean = await this.pingServer(serverUrl);
        this.post({ id: req.id, ok: true, reachable: reachable });
        return;
      }
      if (req.op === 'detect') {
        const input: string = this.requireString(req.input, 'input');
        const serverUrl: string = req.serverUrl === undefined ? '' : req.serverUrl.trim();
        if (serverUrl === '') {
          this.post({ id: req.id, ok: true, quad: null });
          return;
        }
        const quad: number[] | null = await this.detectOnServer(input, serverUrl);
        this.post({ id: req.id, ok: true, quad: quad });
        return;
      }
      if (req.op === 'ocr') {
        const input: string = this.requireString(req.input, 'input');
        const serverUrl: string = req.serverUrl === undefined ? '' : req.serverUrl.trim();
        if (serverUrl === '') {
          throw new Error('未配置识别服务');
        }
        const text: string = await this.ocrOnServer(input, serverUrl);
        this.post({ id: req.id, ok: true, text: text });
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
