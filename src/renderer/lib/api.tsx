import { createContext, useContext, type ReactNode } from 'react';
import type { ApiErrorCode, ApiResult, HfcmApi } from '../../shared/api';

/** The error `unwrap` throws for a failed `ApiResult`; `code` and `detailPath` come from the main process. */
export class ApiCallError extends Error {
  readonly code: ApiErrorCode;
  readonly detailPath?: string;
  constructor(code: ApiErrorCode, message: string, detailPath?: string) {
    super(message);
    this.name = 'ApiCallError';
    this.code = code;
    if (detailPath !== undefined) this.detailPath = detailPath;
  }
}

export function unwrap<T>(r: ApiResult<T>): T {
  if (r.ok) return r.data;
  throw new ApiCallError(r.error.code, r.error.message, r.error.detailPath);
}

const ApiContext = createContext<HfcmApi | null>(null);

/** Injects the API (tests pass a fake). main.tsx passes `window.api`. */
export function ApiProvider({ api, children }: { api: HfcmApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

/** The injected API, else `window.api` (the sandboxed preload bridge). */
export function useApi(): HfcmApi {
  return useContext(ApiContext) ?? window.api;
}
