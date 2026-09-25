import { CORE_URL } from '@/lib/utils/core-url';
import { reportTransportFailure } from './transport-failure';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';


/** WebSocket URL. Prefer `NEXT_PUBLIC_WS_URL`; otherwise derive from the API
 *  URL. With the relative default this resolves to `/ws` (same-origin). */
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || `${CORE_URL.replace(/^http/, 'ws')}/ws`;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
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
  }
  return { message: res.statusText };
}

/**
 * Every request this module makes goes out through here, and it is the ONLY
 * place a rejected `fetch` is reported.
 */
async function sendRequest(endpoint: string, init: RequestInit): Promise<Response> {
  const url = `${API_URL}${endpoint}`;
  try {
    return await fetch(url, init);
  } catch (err) {
    reportTransportFailure(err, { url, method: init.method ?? 'GET' });
    throw err;
  }
}

async function fetchRaw(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const hasBody = options.body !== undefined && options.body !== null;
  const headers = new Headers(options.headers as HeadersInit | undefined);
  if (hasBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await sendRequest(endpoint, {
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
 * Raw-bytes client, for the capability-authenticated upload endpoint: the
 * ticket in the path IS the authorization, so this sends no credentials and no
 * JSON envelope — the body is the file.
 */
export async function apiPutBytes<T>(endpoint: string, file: Blob): Promise<T> {
  const res = await sendRequest(endpoint, {
    method: 'PUT',
    body: file,
    headers: file.type ? { 'Content-Type': file.type } : undefined,
  });
  if (!res.ok) {
    const { message, code, details, body } = await parseErrorBody(res);
    throw new ApiError(res.status, message, code, details, body);
  }
  return (await res.json()) as T;
}

/** Multipart-aware client. Sends FormData without the JSON Content-Type. */
export async function apiMultipart<T>(endpoint: string, formData: FormData): Promise<T> {
  const res = await sendRequest(endpoint, {
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
export async function apiClientList<T, E = unknown>(
  endpoint: string,
  options: RequestInit = {},
): Promise<{ items: T[]; totalCount: number; extra?: E }> {
  const res = await fetchRaw(endpoint, options);
  if (res.status === 204) return { items: [], totalCount: 0 };

  const body = (await res.json()) as T[] | ({ items: T[]; total: number } & Record<string, unknown>);
  if (!Array.isArray(body)) {
    const { items, total, returned, limit, offset, hasMore, ...rest } = body;
    return {
      items: items ?? [],
      totalCount: total,
      ...(Object.keys(rest).length > 0 ? { extra: rest as E } : {}),
    };
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
 * Cursor-paged list client: walks every page and answers the whole set.
 *
 * `total` on a cursor envelope counts what the query matched, which for the
 * comment thread is every comment while a page carries only top-level ones —
 * so it is reported as the caller's `totalCount` and is NOT what the walk
 * stops on.
 */
export async function apiClientCursorAll<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<{ items: T[]; totalCount: number }> {
  const MAX_PAGES = 200;
  const joiner = endpoint.includes("?") ? "&" : "?";
  const items: T[] = [];
  let cursor: string | null = null;
  let totalCount = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = cursor === null ? endpoint : `${endpoint}${joiner}cursor=${encodeURIComponent(cursor)}`;
    const res = await fetchRaw(url, options);
    if (res.status === 204) return { items, totalCount };

    const body = (await res.json()) as
      | { items: T[]; total: number; nextCursor: string | null }
      | unknown;
    if (!isCursorPage<T>(body)) {
      throw new Error(`${endpoint}: answered no cursor envelope — cannot page this list`);
    }
    items.push(...body.items);
    totalCount = body.total;
    cursor = body.nextCursor;
    if (cursor === null) return { items, totalCount };
  }
  throw new Error(`${endpoint}: still returning a cursor after ${MAX_PAGES} pages`);
}

function isCursorPage<T>(
  body: unknown,
): body is { items: T[]; total: number; nextCursor: string | null } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { items?: unknown; total?: unknown; nextCursor?: unknown };
  return Array.isArray(b.items) && typeof b.total === "number" && "nextCursor" in b;
}

/**
 * Unwrap a Strapi-style `{ data: T }` envelope. Agent API responses wrap
 * payloads in `{ data: ... }` for legacy compat; use this at call sites
 * instead of `res.data` to make the unwrap intent explicit and centralized.
 */
export function unwrap<T>(res: { data: T }): T {
  return res.data;
}
