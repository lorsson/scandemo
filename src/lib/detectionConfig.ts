import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_URL_KEY = 'scan.detection.serverUrl.v1';

/**
 * 开发机默认地址（可在「我的」里改）。
 * 服务端是 D:\data\torch_server\demo.py，默认监听 10000；USB 调试时用
 *   adb reverse tcp:10000 tcp:10000
 * 把手机的 127.0.0.1:10000 转到开发机，避免局域网/防火墙问题。
 * 只有开发构建才预填：正式包不应该内置某个局域网 IP。
 */
export const DEFAULT_DETECTION_SERVER_URL = __DEV__
  ? 'http://127.0.0.1:10000'
  : '';

/** 去首尾空白、补协议、去尾部斜杠；空串表示显式关闭服务端识别 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/** 没配置过时返回默认开发机地址；显式清空后返回 '' */
export async function getDetectionServerUrl(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(SERVER_URL_KEY);
    if (stored === null) return DEFAULT_DETECTION_SERVER_URL;
    return normalizeServerUrl(stored);
  } catch {
    return DEFAULT_DETECTION_SERVER_URL;
  }
}

export async function setDetectionServerUrl(url: string | null): Promise<void> {
  if (url === null) {
    await AsyncStorage.removeItem(SERVER_URL_KEY);
    return;
  }
  await AsyncStorage.setItem(SERVER_URL_KEY, normalizeServerUrl(url));
}
