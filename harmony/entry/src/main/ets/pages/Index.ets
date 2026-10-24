import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import imageCore from 'libimage_core.so';
import { ImageCoreService, FilterTimings } from '../image/ImageCoreService';

interface ProcessRequest {
  id: number;
  input: string;
  output: string;
  filter: string;
  quality: number;
}

interface ProcessResult {
  id: number;
  ok: boolean;
  error?: string;
  timings?: FilterTimings;
  output?: string;
}

/**
 * Injected into the ArkWeb page as `window.nativeBridge`.
 * H5 calls nativeBridge.dispatch(json); results are pushed back with
 * runJavaScript -> window.__onNativeResult(...). We avoid relying on
 * Promise return values across the JS proxy boundary.
 */
class NativeBridge {
  controller: webview.WebviewController;

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
  }

  version(): string {
    return imageCore.version();
  }

  dispatch(payload: string): void {
    this.handle(payload);
  }

  private async handle(payload: string): Promise<void> {
    let req: ProcessRequest;
    try {
      req = JSON.parse(payload) as ProcessRequest;
    } catch (e) {
      this.post({ id: -1, ok: false, error: 'bad payload: ' + String(e) });
      return;
    }
    try {
      const timings: FilterTimings = await ImageCoreService.processFile(
        req.input, req.output, req.filter, req.quality
      );
      this.post({ id: req.id, ok: true, timings: timings, output: req.output });
    } catch (e) {
      this.post({ id: req.id, ok: false, error: String(e) });
    }
  }

  private post(result: ProcessResult): void {
    const script: string = 'window.__onNativeResult(' + JSON.stringify(result) + ');';
    this.controller.runJavaScript(script).catch(() => {});
  }
}

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  bridge: NativeBridge = new NativeBridge(this.controller);
  private samplePath: string = '';
  private ready: boolean = false;

  aboutToAppear(): void {
    this.prepareSample();
  }

  private prepareSample(): void {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const data: Uint8Array = ctx.resourceManager.getRawFileContentSync('sample.jpg');
      const path: string = ctx.cacheDir + '/sample.jpg';
      const file: fs.File = fs.openSync(
        path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC
      );
      try {
        fs.writeSync(file.fd, data.buffer as ArrayBuffer);
      } finally {
        fs.closeSync(file);
      }
      this.samplePath = path;
      this.ready = true;
    } catch (e) {
      this.samplePath = '';
    }
  }

  private pushSamplePath(): void {
    const script: string =
      'window.__init(' + JSON.stringify(this.ready ? this.samplePath : '') + ');';
    this.controller.runJavaScript(script).catch(() => {});
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
            this.pushSamplePath();
          })
          .width('100%')
          .height('100%')
      }
      .width('100%')
      .height('100%')

      // 悬浮入口：H5 示例之外的原生 PDF 流程
      Button('图片转 PDF')
        .fontSize(12)
        .height(34)
        .margin({ top: 44, right: 14 })
        .onClick(() => {
          router.pushUrl({ url: 'pages/PdfPage' }).catch(() => {});
        })
    }
    .width('100%')
    .height('100%')
  }
}
