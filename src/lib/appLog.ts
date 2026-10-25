import { logWithNative } from '../../modules/image-core';

/**
 * 流程日志：开发时走 console，正式包（release）里 Hermes 会丢掉 console.*，
 * 所以同时转发给原生模块写进系统日志 —— Android 用
 * `adb logcat -s ImageCore`，iOS 用 Console.app 过滤 `ImageCore/`。
 *
 * 参数按 JSON 序列化，保持 `键=值` 一眼能读；失败（循环引用等）退回 String()。
 */
export function logEvent(tag: string, message: string, data?: unknown): void {
  let suffix = '';
  if (data !== undefined) {
    try {
      suffix = ` ${JSON.stringify(data)}`;
    } catch {
      suffix = ` ${String(data)}`;
    }
  }
  write(tag, message + suffix);
}

/** 失败路径：Error 的 JSON 是空的，单独取 message */
export function logError(tag: string, message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  write(tag, `${message}: ${detail}`);
}

function write(tag: string, line: string): void {
  if (__DEV__) {
    console.log(`[${tag}] ${line}`);
  }
  logWithNative(tag, line);
}
