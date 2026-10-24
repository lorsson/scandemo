import { fileIo as fs } from '@kit.CoreFileKit';

/**
 * 最小 JPEG → PDF 写入器（A4，每页一张图）。
 *
 * 直接嵌入 JPEG 原始数据（/Filter /DCTDecode），PDF 阅读器自己解码，
 * 不需要在内存里重新编码图片；每页处理完立即释放，峰值 ≈ 一页 JPEG。
 * 这正是 docs/EDGE_DETECTION.md §6 里「原生流式写入」的鸿蒙版本。
 */

const A4_WIDTH: number = 595;
const A4_HEIGHT: number = 842;

interface JpegInfo {
  width: number;
  height: number;
  components: number;
}

/** ASCII → 字节；PDF 语法里除图片流外全是 ASCII */
function asciiBytes(text: string): Uint8Array {
  const out: Uint8Array = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

function padNumber(value: number, width: number): string {
  let text: string = value.toString();
  while (text.length < width) {
    text = '0' + text;
  }
  return text;
}

function fmt(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

class ByteSink {
  private fd: number;
  offset: number = 0;

  constructor(fd: number) {
    this.fd = fd;
  }

  /** 追加写入；文件位置由系统自动前移，offset 只用于生成 xref */
  writeBytes(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) {
      return;
    }
    const written: number = fs.writeSync(this.fd, bytes.buffer as ArrayBuffer);
    this.offset += written;
  }

  writeBuffer(buffer: ArrayBuffer): void {
    if (buffer.byteLength === 0) {
      return;
    }
    const written: number = fs.writeSync(this.fd, buffer);
    this.offset += written;
  }

  writeAscii(text: string): void {
    this.writeBytes(asciiBytes(text));
  }
}

function readFileBytes(path: string): Uint8Array {
  const stat: fs.Stat = fs.statSync(path);
  const size: number = stat.size;
  const buffer: ArrayBuffer = new ArrayBuffer(size);
  const file: fs.File = fs.openSync(path, fs.OpenMode.READ_ONLY);
  try {
    const read: number = fs.readSync(file.fd, buffer);
    if (read !== size) {
      throw new Error('读取图片不完整：' + path);
    }
  } finally {
    fs.closeSync(file);
  }
  return new Uint8Array(buffer);
}

/**
 * 从 SOF 段读宽高与分量数。
 * SOF0/SOF1/SOF2 等布局一致：FF Cx | len | precision | height | width | components
 */
function parseJpeg(data: Uint8Array): JpegInfo {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error('不是有效的 JPEG 文件');
  }
  let i: number = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) {
      i++;
      continue;
    }
    const marker: number = data[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    const length: number = (data[i + 2] << 8) | data[i + 3];
    const isSof: boolean =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      const height: number = (data[i + 5] << 8) | data[i + 6];
      const width: number = (data[i + 7] << 8) | data[i + 8];
      const components: number = data[i + 9];
      if (width <= 0 || height <= 0) {
        break;
      }
      return { width: width, height: height, components: components };
    }
    if (marker === 0xda) {
      break;
    }
    i += 2 + length;
  }
  throw new Error('无法解析 JPEG 尺寸');
}

function colorSpaceOf(components: number): string {
  if (components === 1) {
    return '/DeviceGray';
  }
  if (components === 4) {
    return '/DeviceCMYK';
  }
  return '/DeviceRGB';
}

export class PdfWriter {
  /**
   * 逐页写入，内存里同时只有一页 JPEG。
   * @returns 实际写入的页数
   */
  static async write(imagePaths: string[], outputPath: string): Promise<number> {
    const count: number = imagePaths.length;
    if (count === 0) {
      throw new Error('至少需要一张图片');
    }

    const file: fs.File = fs.openSync(
      outputPath,
      fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC
    );
    try {
      const sink: ByteSink = new ByteSink(file.fd);
      const offsets: number[] = [];

      // 文件头
      sink.writeAscii('%PDF-1.4\n');
      sink.writeAscii('%âãÏÓ\n');

      // 1: Catalog
      offsets.push(sink.offset);
      sink.writeAscii('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

      // 2: Pages
      let kids: string = '[';
      for (let i = 0; i < count; i++) {
        if (i > 0) {
          kids += ' ';
        }
        kids += (3 + i * 3).toString() + ' 0 R';
      }
      kids += ']';
      offsets.push(sink.offset);
      sink.writeAscii(
        '2 0 obj\n<< /Type /Pages /Kids ' + kids + ' /Count ' +
        count.toString() + ' >>\nendobj\n'
      );

      for (let i = 0; i < count; i++) {
        const image: Uint8Array = readFileBytes(imagePaths[i]);
        const info: JpegInfo = parseJpeg(image);
        const pageObj: number = 3 + i * 3;
        const contentObj: number = pageObj + 1;
        const imageObj: number = pageObj + 2;

        // 等比缩放到 A4 内并居中
        const scale: number = Math.min(
          A4_WIDTH / info.width,
          A4_HEIGHT / info.height
        );
        const drawWidth: number = info.width * scale;
        const drawHeight: number = info.height * scale;
        const offsetX: number = (A4_WIDTH - drawWidth) / 2;
        const offsetY: number = (A4_HEIGHT - drawHeight) / 2;

        // Page
        offsets.push(sink.offset);
        sink.writeAscii(
          pageObj.toString() + ' 0 obj\n' +
          '<< /Type /Page /Parent 2 0 R ' +
          '/MediaBox [0 0 ' + A4_WIDTH.toString() + ' ' + A4_HEIGHT.toString() + '] ' +
          '/Resources << /XObject << /Im0 ' + imageObj.toString() + ' 0 R >> >> ' +
          '/Contents ' + contentObj.toString() + ' 0 R >>\nendobj\n'
        );

        // Content
        const content: string =
          'q\n' +
          fmt(drawWidth) + ' 0 0 ' + fmt(drawHeight) + ' ' +
          fmt(offsetX) + ' ' + fmt(offsetY) + ' cm\n' +
          '/Im0 Do\nQ\n';
        offsets.push(sink.offset);
        sink.writeAscii(
          contentObj.toString() + ' 0 obj\n' +
          '<< /Length ' + content.length.toString() + ' >>\nstream\n' +
          content + 'endstream\nendobj\n'
        );

        // Image XObject：直接嵌入 JPEG 码流
        offsets.push(sink.offset);
        sink.writeAscii(
          imageObj.toString() + ' 0 obj\n' +
          '<< /Type /XObject /Subtype /Image /Width ' + info.width.toString() +
          ' /Height ' + info.height.toString() +
          ' /ColorSpace ' + colorSpaceOf(info.components) +
          ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
          image.byteLength.toString() + ' >>\nstream\n'
        );
        sink.writeBuffer(image.buffer as ArrayBuffer);
        sink.writeAscii('\nendstream\nendobj\n');
      }

      // xref：每项固定 20 字节
      const xrefOffset: number = sink.offset;
      const totalObjects: number = offsets.length;
      let xref: string = 'xref\n0 ' + (totalObjects + 1).toString() + '\n';
      xref += '0000000000 65535 f \n';
      for (let i = 0; i < totalObjects; i++) {
        xref += padNumber(offsets[i], 10) + ' 00000 n \n';
      }
      sink.writeAscii(xref);
      sink.writeAscii(
        'trailer\n<< /Size ' + (totalObjects + 1).toString() +
        ' /Root 1 0 R >>\nstartxref\n' + xrefOffset.toString() + '\n%%EOF\n'
      );

      return count;
    } finally {
      fs.closeSync(file);
    }
  }
}
