import { image } from '@kit.ImageKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import imageCore from 'libimage_core.so';

export interface FilterTimings {
  width: number;
  height: number;
  decodeMs: number;
  processMs: number;
  encodeMs: number;
  totalMs: number;
  filter: string;
}

/**
 * 一次解码的产物：原始 BGRA 像素 + 仍可复用的 PixelMap。
 * 调用方必须 release()，否则 PixelMap 占着 native 内存。
 */
export class DecodedImage {
  width: number = 0;
  height: number = 0;
  bytes: ArrayBuffer = new ArrayBuffer(0);
  pixelMap: image.PixelMap | undefined = undefined;
  source: image.ImageSource | undefined = undefined;
  file: fs.File | undefined = undefined;

  async release(): Promise<void> {
    if (this.pixelMap !== undefined) {
      await this.pixelMap.release();
      this.pixelMap = undefined;
    }
    if (this.source !== undefined) {
      await this.source.release();
      this.source = undefined;
    }
    if (this.file !== undefined) {
      fs.closeSync(this.file);
      this.file = undefined;
    }
  }
}

// 与 modules/image-core/common/image_core.h 的 Filter 枚举一一对应。
// 新增算法时同步修改这里，否则会静默退回原图。
function filterId(filter: string): number {
  if (filter === 'gray') {
    return 1;
  }
  if (filter === 'bw') {
    return 2;
  }
  if (filter === 'enhance') {
    return 3;
  }
  if (filter === 'shadow') {
    return 4;
  }
  if (filter === 'dehand') {
    return 5;
  }
  if (filter === 'hd') {
    return 6;
  }
  if (filter === 'brighten') {
    return 7;
  }
  if (filter === 'sharpen') {
    return 8;
  }
  if (filter === 'inksave') {
    return 9;
  }
  if (filter === 'invert') {
    return 10;
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * HarmonyOS twin of ImageCoreModule.kt / the iOS Swift bridge:
 * decode + encode happen on the platform side; the shared C++ kernel
 * (modules/image-core/common/image_core.cpp) only rewrites pixels.
 *
 * Pixels are requested as BGRA_8888 so the little-endian uint32 layout is
 * 0xAARRGGBB, exactly what image_core::* expects.
 */
export class ImageCoreService {
  static version(): string {
    return imageCore.version();
  }

  /**
   * 平台侧解码成 BGRA 像素。
   *
   * maxDim > 0 时在解码阶段直接降采样到最长边 maxDim：PDF 页面只需要
   * 1600 px，先解全图再缩小会让 12 MP 照片占用 ~48 MB。
   * 注意这只影响解码尺寸，不是算法——算法依旧是 C++。
   */
  private static async decode(
    inputPath: string,
    maxDim: number
  ): Promise<DecodedImage> {
    const decoded: DecodedImage = new DecodedImage();
    let ok: boolean = false;
    try {
      decoded.file = fs.openSync(inputPath, fs.OpenMode.READ_ONLY);
      decoded.source = image.createImageSource(decoded.file.fd);
      const options: image.DecodingOptions = {
        desiredPixelFormat: image.PixelMapFormat.BGRA_8888,
      };
      if (maxDim > 0) {
        const sourceInfo: image.ImageInfo = await decoded.source.getImageInfo();
        const largest: number = Math.max(
          sourceInfo.size.width,
          sourceInfo.size.height
        );
        if (largest > maxDim) {
          const scale: number = maxDim / largest;
          options.desiredSize = {
            width: Math.max(1, Math.round(sourceInfo.size.width * scale)),
            height: Math.max(1, Math.round(sourceInfo.size.height * scale)),
          };
        }
      }
      decoded.pixelMap = await decoded.source.createPixelMap(options);
      const info: image.ImageInfo = await decoded.pixelMap.getImageInfo();
      decoded.width = info.size.width;
      decoded.height = info.size.height;
      decoded.bytes = new ArrayBuffer(decoded.width * decoded.height * 4);
      await decoded.pixelMap.readPixelsToBuffer(decoded.bytes);
      ok = true;
      return decoded;
    } finally {
      if (!ok) {
        await decoded.release();
      }
    }
  }

  private static async encodeJpeg(
    pixelMap: image.PixelMap,
    outputPath: string,
    quality: number
  ): Promise<void> {
    const packer: image.ImagePacker = image.createImagePacker();
    try {
      const packed: ArrayBuffer = await packer.packing(pixelMap, {
        format: 'image/jpeg',
        quality: clamp(quality, 1, 100),
      });
      const outFile: fs.File = fs.openSync(
        outputPath,
        fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC
      );
      try {
        fs.writeSync(outFile.fd, packed);
      } finally {
        fs.closeSync(outFile);
      }
    } finally {
      await packer.release();
    }
  }

  /** 用一块 BGRA 像素缓冲区造 PixelMap，交给编码器写 JPEG */
  private static async pixelMapFromBuffer(
    bytes: ArrayBuffer,
    width: number,
    height: number
  ): Promise<image.PixelMap> {
    const options: image.InitializationOptions = {
      size: { width: width, height: height },
      srcPixelFormat: image.PixelMapFormat.BGRA_8888,
      pixelFormat: image.PixelMapFormat.BGRA_8888,
      editable: true,
      alphaType: image.AlphaType.UNPREMUL,
    };
    return image.createPixelMap(bytes, options);
  }

  private static timings(
    width: number,
    height: number,
    decodeMs: number,
    processMs: number,
    encodeMs: number,
    totalMs: number,
    op: string
  ): FilterTimings {
    return {
      width: width,
      height: height,
      decodeMs: decodeMs,
      processMs: processMs,
      encodeMs: encodeMs,
      totalMs: totalMs,
      filter: op,
    };
  }

  /**
   * 滤镜（不带微调）。maxDim > 0 时解码阶段降采样。
   * 与 Android processFile / iOS processFile 的输出字段一致。
   */
  static async processFile(
    inputPath: string,
    outputPath: string,
    filter: string,
    quality: number,
    maxDim: number = 0
  ): Promise<FilterTimings> {
    return ImageCoreService.runFilter(
      inputPath, outputPath, filter, quality, maxDim, 0, 0, 0
    );
  }

  /** 滤镜 + 第二步微调（对比度/亮度/细节），与 processFileEx 对应 */
  static async processFileEx(
    inputPath: string,
    outputPath: string,
    filter: string,
    quality: number,
    contrast: number,
    brightness: number,
    detail: number,
    maxDim: number = 0
  ): Promise<FilterTimings> {
    return ImageCoreService.runFilter(
      inputPath, outputPath, filter, quality, maxDim,
      contrast, brightness, detail
    );
  }

  private static async runFilter(
    inputPath: string,
    outputPath: string,
    filter: string,
    quality: number,
    maxDim: number,
    contrast: number,
    brightness: number,
    detail: number
  ): Promise<FilterTimings> {
    const started: number = Date.now();
    const decoded: DecodedImage = await ImageCoreService.decode(inputPath, maxDim);
    try {
      const decodeMs: number = Date.now() - started;

      const processStarted: number = Date.now();
      const id: number = filterId(filter);
      const rc: number =
        contrast === 0 && brightness === 0 && detail === 0
          ? imageCore.processPixels(decoded.bytes, decoded.width, decoded.height, id)
          : imageCore.processPixelsEx(
              decoded.bytes,
              decoded.width,
              decoded.height,
              id,
              clamp(contrast, -50, 50),
              clamp(brightness, -50, 50),
              clamp(detail, 0, 100)
            );
      if (rc !== 0) {
        throw new Error('native process failed, code=' + rc);
      }
      const processMs: number = Date.now() - processStarted;

      // 回到解码出来的 PixelMap 上原地写回，省一次拷贝和一张位图
      const pixelMap: image.PixelMap | undefined = decoded.pixelMap;
      if (pixelMap === undefined) {
        throw new Error('pixel map released too early');
      }
      await pixelMap.writeBufferToPixels(decoded.bytes);

      const encodeStarted: number = Date.now();
      await ImageCoreService.encodeJpeg(pixelMap, outputPath, quality);
      const encodeMs: number = Date.now() - encodeStarted;

      return ImageCoreService.timings(
        decoded.width, decoded.height, decodeMs, processMs, encodeMs,
        Date.now() - started, filter
      );
    } finally {
      await decoded.release();
    }
  }

  /**
   * 四角透视裁剪：quad 为 8 个归一化坐标 TL,TR,BR,BL。
   * 与 Android warpFile / iOS warpFile 一致（输出尺寸规则也在 C++ 里）。
   */
  static async warpFile(
    inputPath: string,
    outputPath: string,
    quad: number[],
    quality: number,
    maxDim: number
  ): Promise<FilterTimings> {
    const started: number = Date.now();
    const decoded: DecodedImage = await ImageCoreService.decode(inputPath, 0);
    try {
      const decodeMs: number = Date.now() - started;

      const quadArray: Float64Array = new Float64Array(8);
      for (let i = 0; i < 8; i++) {
        quadArray[i] = i < quad.length ? quad[i] : 0;
      }
      const size: number[] = imageCore.warpSize(
        decoded.width, decoded.height, quadArray, maxDim
      );
      const dstWidth: number = Math.max(8, size[0]);
      const dstHeight: number = Math.max(8, size[1]);

      const processStarted: number = Date.now();
      const dst: ArrayBuffer = new ArrayBuffer(dstWidth * dstHeight * 4);
      const rc: number = imageCore.warpPixels(
        decoded.bytes, decoded.width, decoded.height,
        dst, dstWidth, dstHeight, quadArray
      );
      if (rc !== 0) {
        throw new Error('native warp failed, code=' + rc);
      }
      const processMs: number = Date.now() - processStarted;

      const outMap: image.PixelMap =
        await ImageCoreService.pixelMapFromBuffer(dst, dstWidth, dstHeight);
      try {
        const encodeStarted: number = Date.now();
        await ImageCoreService.encodeJpeg(outMap, outputPath, quality);
        const encodeMs: number = Date.now() - encodeStarted;
        return ImageCoreService.timings(
          dstWidth, dstHeight, decodeMs, processMs, encodeMs,
          Date.now() - started, 'warp'
        );
      } finally {
        await outMap.release();
      }
    } finally {
      await decoded.release();
    }
  }

  /** 等比缩放到最长边 maxDim（不放大）；与 Android / iOS resizeFile 一致 */
  static async resizeFile(
    inputPath: string,
    outputPath: string,
    maxDim: number,
    quality: number
  ): Promise<FilterTimings> {
    const started: number = Date.now();
    const decoded: DecodedImage = await ImageCoreService.decode(inputPath, 0);
    try {
      const decodeMs: number = Date.now() - started;
      const size: number[] = imageCore.resizeSize(
        decoded.width, decoded.height, maxDim
      );
      const dstWidth: number = Math.max(1, size[0]);
      const dstHeight: number = Math.max(1, size[1]);

      const processStarted: number = Date.now();
      // 尺寸没变：C++ 侧就是 memcpy，直接编码原 PixelMap 更快
      if (dstWidth === decoded.width && dstHeight === decoded.height) {
        const pixelMap: image.PixelMap | undefined = decoded.pixelMap;
        if (pixelMap === undefined) {
          throw new Error('pixel map released too early');
        }
        const processMs: number = Date.now() - processStarted;
        const encodeStarted: number = Date.now();
        await ImageCoreService.encodeJpeg(pixelMap, outputPath, quality);
        const encodeMs: number = Date.now() - encodeStarted;
        return ImageCoreService.timings(
          dstWidth, dstHeight, decodeMs, processMs, encodeMs,
          Date.now() - started, 'resize'
        );
      }

      const dst: ArrayBuffer = new ArrayBuffer(dstWidth * dstHeight * 4);
      const rc: number = imageCore.resizePixels(
        decoded.bytes, decoded.width, decoded.height,
        dst, dstWidth, dstHeight
      );
      if (rc !== 0) {
        throw new Error('native resize failed, code=' + rc);
      }
      const processMs: number = Date.now() - processStarted;

      const outMap: image.PixelMap =
        await ImageCoreService.pixelMapFromBuffer(dst, dstWidth, dstHeight);
      try {
        const encodeStarted: number = Date.now();
        await ImageCoreService.encodeJpeg(outMap, outputPath, quality);
        const encodeMs: number = Date.now() - encodeStarted;
        return ImageCoreService.timings(
          dstWidth, dstHeight, decodeMs, processMs, encodeMs,
          Date.now() - started, 'resize'
        );
      } finally {
        await outMap.release();
      }
    } finally {
      await decoded.release();
    }
  }

  /** 顺时针旋转 90 / 180 / 270；与 Android / iOS rotateFile 一致 */
  static async rotateFile(
    inputPath: string,
    outputPath: string,
    degrees: number,
    quality: number
  ): Promise<FilterTimings> {
    const normalized: number = ((degrees % 360) + 360) % 360;
    if (normalized !== 90 && normalized !== 180 && normalized !== 270) {
      throw new Error('旋转角度只支持 90 / 180 / 270');
    }
    const started: number = Date.now();
    const decoded: DecodedImage = await ImageCoreService.decode(inputPath, 0);
    try {
      const decodeMs: number = Date.now() - started;
      const swap: boolean = normalized !== 180;
      const dstWidth: number = swap ? decoded.height : decoded.width;
      const dstHeight: number = swap ? decoded.width : decoded.height;

      const processStarted: number = Date.now();
      const dst: ArrayBuffer = new ArrayBuffer(dstWidth * dstHeight * 4);
      const rc: number = imageCore.rotatePixels(
        decoded.bytes, decoded.width, decoded.height, dst, normalized
      );
      if (rc !== 0) {
        throw new Error('native rotate failed, code=' + rc);
      }
      const processMs: number = Date.now() - processStarted;

      const outMap: image.PixelMap =
        await ImageCoreService.pixelMapFromBuffer(dst, dstWidth, dstHeight);
      try {
        const encodeStarted: number = Date.now();
        await ImageCoreService.encodeJpeg(outMap, outputPath, quality);
        const encodeMs: number = Date.now() - encodeStarted;
        return ImageCoreService.timings(
          dstWidth, dstHeight, decodeMs, processMs, encodeMs,
          Date.now() - started, 'rotate'
        );
      } finally {
        await outMap.release();
      }
    } finally {
      await decoded.release();
    }
  }

  /**
   * 列表缩略图（默认 220 px 宽）。
   *
   * 与 RN 端 resizeToWidth 相同：把「按宽缩放」换算成最长边，再走同一个
   * C++ resize_pixels，不在平台侧另做一套缩放。
   */
  static async makeThumbnail(
    inputPath: string,
    outputPath: string,
    width: number
  ): Promise<void> {
    const srcFile: fs.File = fs.openSync(inputPath, fs.OpenMode.READ_ONLY);
    let source: image.ImageSource | undefined = undefined;
    try {
      source = image.createImageSource(srcFile.fd);
      const info: image.ImageInfo = await source.getImageInfo();
      const targetWidth: number = Math.max(1, Math.min(width, info.size.width));
      const targetHeight: number = Math.max(
        1,
        Math.round(info.size.height * (targetWidth / info.size.width))
      );
      await ImageCoreService.resizeFile(
        inputPath, outputPath, Math.max(targetWidth, targetHeight), 70
      );
    } finally {
      if (source !== undefined) {
        await source.release();
      }
      fs.closeSync(srcFile);
    }
  }
}
