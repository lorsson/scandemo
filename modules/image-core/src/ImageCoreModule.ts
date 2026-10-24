import { requireNativeModule } from 'expo-modules-core';

export type NativeFilterKey = 'original' | 'enhance' | 'gray' | 'bw';

export type NativeProcessResult = {
  width: number;
  height: number;
  decodeMs: number;
  processMs: number;
  encodeMs: number;
  totalMs: number;
  filter: NativeFilterKey;
};

type ImageCoreNativeModule = {
  version(): string;
  processFile(
    inputPath: string,
    outputPath: string,
    filter: NativeFilterKey,
    quality: number,
  ): Promise<NativeProcessResult>;
};

/**
 * Expo Go 里没有这个原生模块，requireNativeModule 会抛错。
 * 这里只记录可用的实例，让上层可以退回到 WebView 实现。
 */
let nativeModule: ImageCoreNativeModule | null = null;
let loadError: Error | null = null;

try {
  nativeModule = requireNativeModule<ImageCoreNativeModule>('ImageCore');
} catch (e) {
  loadError = e instanceof Error ? e : new Error(String(e));
}

export function isImageCoreAvailable(): boolean {
  return nativeModule != null;
}

export function imageCoreVersion(): string | null {
  return nativeModule?.version() ?? null;
}

export function imageCoreLoadError(): Error | null {
  return loadError;
}

export async function processFileWithNative(
  inputPath: string,
  outputPath: string,
  filter: NativeFilterKey,
  quality = 92,
): Promise<NativeProcessResult> {
  if (!nativeModule) {
    throw loadError ?? new Error('ImageCore 原生模块不可用');
  }
  return nativeModule.processFile(inputPath, outputPath, filter, quality);
}
