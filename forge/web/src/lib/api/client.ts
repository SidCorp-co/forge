const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';

/** Core base URL without `/api` suffix — used to derive the WS URL. */
const CORE_URL = API_URL.replace(/\/api\/?$/, '');

/** WebSocket URL. Prefer `NEXT_PUBLIC_WS_URL`; otherwise derive from the API URL. */
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || `${CORE_URL.replace(/^http/, 'ws')}/ws`;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (code !== undefined) this.code = code;
    if (details !== undefined) this.details = details;
  }
}

async function parseErrorBody(res: Response): Promise<{ message: string; code?: string; details?: unknown }> {
  try {
    const body = await res.json();
    if (body && typeof body === 'object') {
      const msg = typeof body.message === 'string' ? body.message : res.statusText;
      const code = typeof body.code === 'string' ? body.code : undefined;
      return { message: msg, code, details: body.details };
    }
  } catch {
    // fall through to statusText
  }
  return { message: res.statusText };
}

async function fetchRaw(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const hasBody = options.body !== undefined && options.body !== null;
  const res = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const { message, code, details } = await parseErrorBody(res);
    throw new ApiError(res.status, message, code, details);
  }

  return res;
}

/** JSON-returning client. Returns `undefined` on 204 No Content. */
export async function apiClient<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetchRaw(endpoint, options);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Transitional shim — Strapi media URL resolver. Phase 2.6 has no `/upload`
 * endpoint on `forge/core`; callers remain only so that the F1 typecheck
 * stays green. F2 deletes every caller and removes this shim.
 *
 * @deprecated removed in Phase 2.6-F2
 */
export function strapiMediaUrl(url: string): string {
  return url;
}

/**
 * Transitional shim — Strapi upload. Always throws. Replaced in a later phase
 * with a real upload endpoint on `forge/core`.
 *
 * @deprecated removed in Phase 2.6-F2
 */
// biome-ignore lint/suspicious/noExplicitAny: shim matches legacy return shape
export async function apiUpload(_formData: FormData): Promise<any> {
  throw new ApiError(
    501,
    'uploads are not implemented on forge/core yet (Phase 2.6-F2 removes every caller)',
    'NOT_IMPLEMENTED',
  );
}

/** List-returning client. Core returns `T[]` with `X-Total-Count` header. */
export async function apiClientList<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<{ items: T[]; totalCount: number }> {
  const res = await fetchRaw(endpoint, options);
  const items = (res.status === 204 ? [] : ((await res.json()) as T[])) ?? [];
  const header = res.headers.get('X-Total-Count');
  const totalCount = header !== null ? Number(header) : items.length;
  return { items, totalCount };
}
