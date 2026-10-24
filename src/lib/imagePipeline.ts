import { Image } from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';

/** 把打包进 app 的静态图片解析为本地 file uri */
export async function resolveBundledAsset(moduleId: number): Promise<string> {
  const asset = Asset.fromModule(moduleId);
  // Expo Go / expo-updates 直接给到磁盘路径，可以直接用。
  // （独立包里 localUri 可能是 drawable 资源名，所以必须确认是 file://）
  if (asset.localUri?.startsWith('file://') && !asset.localUri.startsWith('file:///android_res/')) {
    return asset.localUri;
  }
  // 独立安装包里，打包图片会被 aapt 编成 drawable 资源，expo-asset 解析出的
  // uri 是资源名（如 "3c"）或 file:///android_res/...，都不是文件路径，
  // Image.getSize / ImageManipulator 读不了。清掉 downloaded 标记，让
  // expo-asset 走原生分支把资源复制到缓存目录。
  asset.localUri = null;
  asset.downloaded = false;
  await asset.downloadAsync();
  if (!asset.localUri) {
    console.warn('[image-core] 资源提取失败', asset.uri);
  }
  return asset.localUri ?? asset.uri;
}

export function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

/**
 * 按最长边等比缩小并重新编码为 JPEG。
 * alwaysEncode=true 时即使尺寸没超限也会转成 JPEG——PDF 源图需要稳定的
 * .jpg 扩展名和 MIME，不能把 PNG/HEIC 原文件直接拷进去。
 */
export async function resizeImage(
  uri: string,
  maxDim: number,
  compress = 0.92,
  alwaysEncode = false,
): Promise<string> {
  const { width, height } = await getImageSize(uri);
  const largest = Math.max(width, height);
  if (largest <= maxDim && !alwaysEncode) {
    return uri;
  }
  const scale = largest > maxDim ? maxDim / largest : 1;
  const result = await manipulateAsync(
    uri,
    [{
      resize: {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      },
    }],
    { compress, format: SaveFormat.JPEG },
  );
  return result.uri;
}

/**
 * 预览用的标准尺寸。再大只会增加 WebView 与磁盘的开销，
 * 1400px 对手机查看已经足够清晰。
 */
export function prepareBase(uri: string, maxDim = 1400): Promise<string> {
  return resizeImage(uri, maxDim, 0.92);
}

export async function rotateImage(uri: string, degree: 90 | 180 | 270): Promise<string> {
  const result = await manipulateAsync(uri, [{ rotate: degree }], {
    compress: 0.95,
    format: SaveFormat.JPEG,
  });
  return result.uri;
}

export async function readBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: 'base64' as any });
}
