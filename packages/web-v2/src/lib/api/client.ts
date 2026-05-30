// Ported from `packages/web/src/lib/api/client.ts` (ISS-288). The ONLY
// intentional divergence is the `API_URL` default: web-v2 mounts under `/v2`
// on the same origin as core, so the default is the RELATIVE `/api` (not the
// v1 `http://localhost:8080/api` absolute). Same-origin keeps the httpOnly
// `forge_auth` cookie attached and lets the dev/CI `/api` + `/ws` rewrites
// (next.config.ts → E2E_CORE_PROXY_URL) proxy to core. Keep the rest in sync
// with v1 — query/auth semantics are shared.
const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

/** Core base URL without `/api` suffix — used to derive the WS URL. Empty
 *  string for the relative default, which yields a relative `/ws` (resolved
 *  same-origin by the browser + proxied in dev). */
const CORE_URL = API_URL.replace(/\/api\/?$/, '');

/** WebSocket URL. Prefer `NEXT_PUBLIC_WS_URL`; otherwise derive from the API
 *  URL. With the relative default this resolves to `/ws` (same-origin). */
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || `${CORE_URL.replace(/^http/, 'ws')}/ws`;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  // Raw parsed JSON response body. Captured so callers can read non-error-shaped
  // payloads on 4xx/5xx (e.g. the 410 `{ archived: true, path }` envelope from
  // `GET /api/jobs/:id/prompt`). Undefined when the body wasn't JSON.
  readonly body?: unknown;

  constructor(
    status: number,
    message: string,
    code?: string,
    details?: unknown,
    body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (code !== undefined) this.code = code;
    if (details !== undefined) this.details = details;
    if (body !== undefined) this.body = body;
  }
}

async function parseErrorBody(res: Response): Promise<{
  message: string;
  code?: string;
  details?: unknown;
  body?: unknown;
}> {
  try {
    const body = await res.json();
    if (body && typeof body === 'object') {
      const msg = typeof body.message === 'string' ? body.message : res.statusText;
      const code = typeof body.code === 'string' ? body.code : undefined;
      return { message: msg, code, details: body.details, body };
    }
    return { message: res.statusText, body };
  } catch {
    // fall through to statusText
  }
  return { message: res.statusText };
}

async function fetchRaw(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const hasBody = options.body !== undefined && options.body !== null;
  const headers = new Headers(options.headers as HeadersInit | undefined);
  if (hasBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  if (!res.ok) {
    const { message, code, details, body } = await parseErrorBody(res);
    throw new ApiError(res.status, message, code, details, body);
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
 * Resolve a server-relative path (e.g. `/api/attachments/abc/download`) to an
 * absolute URL anchored at the core API origin. Pass-through for absolute URLs
 * and empty input. Use for `<img src>`, `<video src>`, and `<a href>` where
 * `fetch` wrappers aren't involved and the browser would otherwise resolve
 * against the web origin. With the relative default `CORE_URL` is empty, so
 * the path is returned unchanged (already same-origin).
 */
export function coreFileUrl(path: string): string {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return `${CORE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Multipart-aware client. Sends FormData without the JSON Content-Type. */
export async function apiMultipart<T>(endpoint: string, formData: FormData): Promise<T> {
  const res = await fetch(`${API_URL}${endpoint}`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  if (!res.ok) {
    const { message, code, details, body } = await parseErrorBody(res);
    throw new ApiError(res.status, message, code, details, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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

/**
 * Unwrap a Strapi-style `{ data: T }` envelope. Agent API responses wrap
 * payloads in `{ data: ... }` for legacy compat; use this at call sites
 * instead of `res.data` to make the unwrap intent explicit and centralized.
 */
export function unwrap<T>(res: { data: T }): T {
  return res.data;
}
