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
  return 0;
}

/**
 * HarmonyOS twin of ImageCoreModule.kt / the iOS Swift bridge:
 * decode + encode happen on the platform side; the shared C++ kernel
 * (modules/image-core/common/image_core.cpp) only rewrites pixels.
 *
 * Pixels are requested as BGRA_8888 so the little-endian uint32 layout is
 * 0xAARRGGBB, exactly what image_core::process_pixels expects.
 */
export class ImageCoreService {
  static version(): string {
    return imageCore.version();
  }

  /**
   * maxDim > 0 时在解码阶段直接降采样到最长边 maxDim：PDF 页面只需要
   * 1600 px，先解全图再缩小会让 12 MP 照片占用 ~48 MB。
   */
  static async processFile(
    inputPath: string,
    outputPath: string,
    filter: string,
    quality: number,
    maxDim: number = 0
  ): Promise<FilterTimings> {
    const started: number = Date.now();

    const srcFile: fs.File = fs.openSync(inputPath, fs.OpenMode.READ_ONLY);
    let source: image.ImageSource | undefined = undefined;
    let pixelMap: image.PixelMap | undefined = undefined;
    let packer: image.ImagePacker | undefined = undefined;
    try {
      source = image.createImageSource(srcFile.fd);
      const options: image.DecodingOptions = {
        desiredPixelFormat: image.PixelMapFormat.BGRA_8888,
      };
      if (maxDim > 0) {
        const sourceInfo: image.ImageInfo = await source.getImageInfo();
        const largest: number = Math.max(
          sourceInfo.size.width, sourceInfo.size.height
        );
        if (largest > maxDim) {
          const scale: number = maxDim / largest;
          options.desiredSize = {
            width: Math.max(1, Math.round(sourceInfo.size.width * scale)),
            height: Math.max(1, Math.round(sourceInfo.size.height * scale)),
          };
        }
      }
      pixelMap = await source.createPixelMap(options);
      const info: image.ImageInfo = await pixelMap.getImageInfo();
      const width: number = info.size.width;
      const height: number = info.size.height;
      const decodeMs: number = Date.now() - started;

      const bytes: ArrayBuffer = new ArrayBuffer(width * height * 4);
      await pixelMap.readPixelsToBuffer(bytes);

      const processStarted: number = Date.now();
      const rc: number = imageCore.processPixels(bytes, width, height, filterId(filter));
      if (rc !== 0) {
        throw new Error('native process failed, code=' + rc);
      }
      const processMs: number = Date.now() - processStarted;

      await pixelMap.writeBufferToPixels(bytes);

      const encodeStarted: number = Date.now();
      packer = image.createImagePacker();
      const packed: ArrayBuffer = await packer.packing(pixelMap, {
        format: 'image/jpeg',
        quality: quality,
      });
      const encodeMs: number = Date.now() - encodeStarted;

      const outFile: fs.File = fs.openSync(
        outputPath,
        fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC
      );
      try {
        fs.writeSync(outFile.fd, packed);
      } finally {
        fs.closeSync(outFile);
      }

      return {
        width: width,
        height: height,
        decodeMs: decodeMs,
        processMs: processMs,
        encodeMs: encodeMs,
        totalMs: Date.now() - started,
        filter: filter,
      };
    } finally {
      if (packer !== undefined) {
        await packer.release();
      }
      if (pixelMap !== undefined) {
        await pixelMap.release();
      }
      if (source !== undefined) {
        await source.release();
      }
      fs.closeSync(srcFile);
    }
  }

  /**
   * 生成列表缩略图（默认 220 px 宽）。
   * 列表只解码小图，避免几十页 1600 px 的预览同时占内存。
   */
  static async makeThumbnail(
    inputPath: string,
    outputPath: string,
    width: number
  ): Promise<void> {
    const srcFile: fs.File = fs.openSync(inputPath, fs.OpenMode.READ_ONLY);
    let source: image.ImageSource | undefined = undefined;
    let pixelMap: image.PixelMap | undefined = undefined;
    let packer: image.ImagePacker | undefined = undefined;
    try {
      source = image.createImageSource(srcFile.fd);
      const info: image.ImageInfo = await source.getImageInfo();
      const targetWidth: number = Math.min(width, info.size.width);
      const targetHeight: number = Math.max(
        1,
        Math.round(info.size.height * (targetWidth / info.size.width))
      );
      pixelMap = await source.createPixelMap({
        desiredSize: { width: targetWidth, height: targetHeight },
      });
      packer = image.createImagePacker();
      const packed: ArrayBuffer = await packer.packing(pixelMap, {
        format: 'image/jpeg',
        quality: 70,
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
      if (packer !== undefined) {
        await packer.release();
      }
      if (pixelMap !== undefined) {
        await pixelMap.release();
      }
      if (source !== undefined) {
        await source.release();
      }
      fs.closeSync(srcFile);
    }
  }
}
