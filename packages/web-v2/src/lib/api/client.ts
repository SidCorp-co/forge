// Originally ported from v1 (ISS-288). The `API_URL` default is the RELATIVE
// `/api`: web-v2 is same-origin with core in dev/CI, so a relative base keeps
// the httpOnly `forge_auth` cookie attached and lets the `/api` + `/ws`
// rewrites (next.config.ts → E2E_CORE_PROXY_URL) proxy to core. In prod
// NEXT_PUBLIC_API_URL is set to core's absolute origin at build time.
import { CORE_URL } from '@/lib/utils/core-url';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';


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

/**
 * List-returning client. Core answers a paginated list with a
 * `{ items, total, hasMore, … }` envelope; routes that do not paginate still
 * answer with a bare array.
 */
// cm:guard a paginated response must carry its own total — in the BODY, or in `X-Total-Count` for the routes still on the array shape. Neither present is an ERROR, never `items.length`: that fallback made a truncated page indistinguishable from a complete list, silently, and 50 of 900 rows read as "900 of 900" while every caller comparing the two to decide whether to fetch more simply stopped.
// cm:edge contract -> packages/core/src/lib/pagination.ts — `listResponse` builds the envelope this reads, and `setTotalCount` writes the header form; a paginated route that emits neither fails here rather than under-reporting its own size
// cm:edge contract -> packages/core/src/index.ts — `exposeHeaders: ['X-Total-Count']` is what lets a browser read the header form at all; drop it and every array-shaped list throws rather than quietly truncating
export async function apiClientList<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<{ items: T[]; totalCount: number }> {
  const res = await fetchRaw(endpoint, options);
  // cm:why 204 carries no body and no header by design — an empty list is complete at zero, and demanding a total here would fail every route that answers "nothing" without one
  if (res.status === 204) return { items: [], totalCount: 0 };

  const body = (await res.json()) as T[] | { items: T[]; total: number };
  if (!Array.isArray(body)) {
    return { items: body.items ?? [], totalCount: body.total };
  }

  const items = body ?? [];
  const header = res.headers.get('X-Total-Count');
  if (header === null) {
    throw new Error(
      `${endpoint}: list response states no total — cannot tell a full list from a truncated page`,
    );
  }
  const totalCount = Number(header);
  if (!Number.isFinite(totalCount)) {
    throw new Error(`${endpoint}: X-Total-Count is not a number (${header})`);
  }
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
