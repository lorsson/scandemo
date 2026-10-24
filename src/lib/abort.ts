import { t } from './i18n';

/** 取消操作时统一的错误类型（name 为 AbortError，UI 里静默处理） */
export function abortError(): Error {
  const err = new Error(t('errorCancelled'));
  err.name = 'AbortError';
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
