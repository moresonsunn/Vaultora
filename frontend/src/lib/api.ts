/* Typed HTTP client: session cookie + CSRF header + timeouts.
 * Mirrors the backend routes 1:1. 401 -> onUnauthorized() (app logs out),
 * unless noAuthRedirect is set (login form surfaces the real error). */
import { ApiError } from './types';

export interface ApiOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Plain objects are JSON-encoded; FormData/ArrayBuffer pass through. */
  body?: unknown;
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined>;
  noAuthRedirect?: boolean;
  timeoutMs?: number;
}

let csrf: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setCsrf(token: string | null): void {
  csrf = token;
}
export function getCsrf(): string | null {
  return csrf;
}
export function onUnauthorized(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

function withQuery(path: string, query?: ApiOptions['query']): string {
  if (!query) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { noAuthRedirect, timeoutMs, query, body, headers, ...rest } = opts;
  const init: RequestInit = {
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'fetch', ...(headers || {}) },
    ...rest,
  };
  if (csrf && !['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase())) {
    (init.headers as Record<string, string>)['X-CSRF-Token'] = csrf;
  }
  if (body !== undefined && typeof body === 'object' && !(body instanceof FormData)) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (body !== undefined) {
    init.body = body as BodyInit;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs) {
    const ctrl = new AbortController();
    init.signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }
  let res: Response;
  try {
    res = await fetch(withQuery(path, query), init);
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError(
        0,
        'Request timed out — the browser blocked it or the server is unreachable (check ad-blocker / Brave Shields / VPN for this site)',
        'timeout'
      );
    }
    throw new ApiError(0, 'Network error — cannot reach the server', 'network');
  }
  if (timer) clearTimeout(timer);

  if (res.status === 401 && !noAuthRedirect) {
    unauthorizedHandler?.();
    throw new ApiError(401, 'Signed out — please sign in again', 'unauthorized');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && 'error' in data && String((data as { error: unknown }).error)) ||
      `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, (data as { need_totp?: boolean })?.need_totp ? 'need_totp' : undefined);
  }
  return data as T;
}

/** Raw binary download helper (blob URLs never touch JSON parsing). */
export async function apiBlob(path: string, opts: ApiOptions = {}): Promise<Blob> {
  const { query, headers, body, method, signal } = opts;
  const init: RequestInit = {
    credentials: 'same-origin',
    method,
    signal,
    headers: { 'X-Requested-With': 'fetch', ...(headers || {}) },
  };
  if (csrf && (init.method || 'GET') !== 'GET') {
    (init.headers as Record<string, string>)['X-CSRF-Token'] = csrf;
  }
  if (body !== undefined && typeof body === 'object') {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(withQuery(path, query), init);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as { error?: string })?.error || 'Download failed');
  }
  return res.blob();
}

export function downloadUrl(path: string, query?: Record<string, string>): string {
  return withQuery(path, query);
}
