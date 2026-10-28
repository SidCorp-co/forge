import { CORE_URL } from '@/lib/utils/core-url';
import { markUnreachable, reportTransportFailure } from './transport-failure';

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
  /** How long the server asked the caller to wait before asking again (`Retry-After`), where it said. */
  readonly retryAfterMs?: number;
  /** When that wait ends, as a time: the answer arrived as this was made, so a wait shown later counts down
   *  from here rather than starting over (ISS-1229 r51). Only a read's: the web counts a wait beside a failed
   *  read's Retry and nowhere else, so a write keeps the server's sentence and the time it names (r53). */
  readonly retryAt?: number;
  /** Which read this answers, as the client holds it (`GET /projects`): one read's wait is told once, wherever shown (r54). */
  readonly read?: string;

  /** `counted` is true for a read's wait, which counts from now; false for a write's; a time for a held read's,
   *  whose wait ends when the refusal it repeats said (r54). */
  constructor(
    status: number,
    message: string,
    code?: string,
    details?: unknown,
    body?: unknown,
    retryAfterMs?: number,
    counted: boolean | number = true,
    read?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (code !== undefined) this.code = code;
    if (details !== undefined) this.details = details;
    if (body !== undefined) this.body = body;
    if (read !== undefined) this.read = read;
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
      if (counted !== false) this.retryAt = counted === true ? Date.now() + retryAfterMs : counted;
    }
  }
}

/** `Retry-After` as milliseconds from now: delta-seconds or an HTTP date; absent or unreadable is undefined. */
export function retryAfterOf(header: string | null, now = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The standard HTTP reason phrases. A message that is one of these, whole, is the status's name
 *  and not anything the server said about this request. */
const REASON_PHRASES = new Set(
  [
    'bad request', 'unauthorized', 'payment required', 'forbidden', 'not found',
    'method not allowed', 'not acceptable', 'proxy authentication required', 'request timeout',
    'conflict', 'gone', 'length required', 'precondition failed', 'payload too large',
    'content too large', 'request entity too large', 'uri too long', 'unsupported media type',
    'range not satisfiable', 'expectation failed', "i'm a teapot", 'misdirected request',
    'unprocessable entity', 'unprocessable content', 'locked', 'failed dependency', 'too early',
    'upgrade required', 'precondition required', 'too many requests',
    'request header fields too large', 'unavailable for legal reasons',
    'internal server error', 'not implemented', 'bad gateway', 'service unavailable',
    'gateway timeout', 'http version not supported', 'variant also negotiates',
    'insufficient storage', 'loop detected', 'not extended', 'network authentication required',
  ],
);

/** Whether a message says nothing beyond the status it came with. */
export function isReasonPhrase(text: string): boolean {
  return REASON_PHRASES.has(text.trim().replace(/\.$/, '').toLowerCase());
}

/** When to ask again, said after what happened, where the status names a time to wait. */
const ASK_AGAIN: Record<number, string> = {
  408: 'Try again.',
  429: 'Wait a moment, then try again.',
  502: 'Try again in a moment.',
  503: 'Try again in a moment.',
  504: 'Try again in a moment.',
};

/** What happened, never when to ask again: where the web counts a wait beside Retry, only that count says how long (r52). */
export function unsaidHappening(status: number): string {
  switch (status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return 'You do not have access to do that.';
    case 404:
      return 'What this asked for was not found. It may have been moved or deleted.';
    case 408:
      return 'The request took too long to reach the server.';
    case 409:
      return 'Something changed since this page loaded. Reload it, then try again.';
    case 413:
      return 'What was sent is larger than the server accepts.';
    case 429:
      return 'Too many requests in a short time.';
    case 502:
    case 504:
      return 'The server did not answer in time.';
    case 503:
      return 'The server is unavailable right now.';
  }
  return status >= 500
    ? 'The server ran into a problem and could not finish the request.'
    : 'The server refused the request without saying why.';
}

/** A failure the server answered without saying why, in words a person can act on. */
export function unsaidFailure(status: number): string {
  const again = ASK_AGAIN[status];
  return again ? `${unsaidHappening(status)} ${again}` : unsaidHappening(status);
}

/** What the server said, where it said anything; a body with no message of its own (an empty
 *  400, a proxy's 429 page) is carried as {@link unsaidFailure}, never as the reason phrase. */
async function parseErrorBody(res: Response): Promise<{
  message: string;
  code?: string;
  details?: unknown;
  body?: unknown;
}> {
  const said = (text: unknown) =>
    typeof text === 'string' && text.trim() !== '' && !isReasonPhrase(text) ? text : unsaidFailure(res.status);
  try {
    const body = await res.json();
    if (body && typeof body === 'object') {
      const code = typeof body.code === 'string' ? body.code : undefined;
      return { message: said(body.message), code, details: body.details, body };
    }
    return { message: said(null), body };
  } catch {
  }
  return { message: said(null) };
}

/** Whether a request reads: only a read's failure is offered Retry, and only beside a Retry is a wait counted. */
function isRead(method: string | undefined): boolean {
  const verb = (method ?? 'GET').toUpperCase();
  return verb === 'GET' || verb === 'HEAD';
}

/** A refused answer as the error every caller reads, carrying when the server asked to be asked again. */
async function errorOf(res: Response, method: string | undefined, read?: string): Promise<ApiError> {
  const { message, code, details, body } = await parseErrorBody(res);
  return new ApiError(res.status, message, code, details, body, retryAfterOf(res.headers.get('Retry-After')), isRead(method), read);
}

/** A read the server refused with a wait, kept until that wait ends. */
interface HeldRead {
  status: number;
  message: string;
  code?: string;
  details?: unknown;
  body?: unknown;
  /** The wait the server asked for, as it said it: what was asked stays true while what is left shrinks. */
  asked: number;
  retryAt: number;
}

/** Where the held reads outlive a page load: a reload is one more way of asking again (judge-168, z4). */
const HELD_KEY = 'forge.heldReads';
let heldReads: Map<string, HeldRead> | null = null;

function held(): Map<string, HeldRead> {
  if (heldReads) return heldReads;
  heldReads = new Map();
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(HELD_KEY) ?? '{}') as Record<string, HeldRead>;
    for (const [read, refusal] of Object.entries(stored)) {
      if (typeof refusal?.retryAt === 'number' && refusal.retryAt > Date.now()) heldReads.set(read, refusal);
    }
  } catch {
  }
  return heldReads;
}

function storeHeld(reads: Map<string, HeldRead>): void {
  try {
    if (reads.size === 0) window.sessionStorage.removeItem(HELD_KEY);
    else window.sessionStorage.setItem(HELD_KEY, JSON.stringify(Object.fromEntries(reads)));
  } catch {
  }
}

/**
 * The refusal a read is held on, repeated while the server's wait runs, ending when it ends (ISS-1229 r54). A read
 * the server refused with a wait is not asked again before that wait ends, whoever asks and however: a refetch, a
 * changed key, an effect run again, a reload. The one Retry waits the wait out and then sends.
 */
function heldRefusal(read: string): ApiError | null {
  const reads = held();
  const refusal = reads.get(read);
  if (!refusal) return null;
  if (refusal.retryAt <= Date.now()) {
    reads.delete(read);
    storeHeld(reads);
    return null;
  }
  const { status, message, code, details, body, asked, retryAt } = refusal;
  return new ApiError(status, message, code, details, body, asked, retryAt, read);
}

function noteAnswer(read: string, refused: ApiError | null): void {
  const reads = held();
  if (refused?.retryAt !== undefined && refused.retryAfterMs !== undefined) {
    const { status, message, code, details, body, retryAfterMs: asked, retryAt } = refused;
    reads.set(read, { status, message, code, details, body, asked, retryAt });
  } else if (!reads.delete(read)) {
    return;
  }
  storeHeld(reads);
}

/** Forgets every held read: a test's fresh page. */
export function forgetHeldReads(): void {
  heldReads = new Map();
  storeHeld(heldReads);
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
    markUnreachable(err);
    throw err;
  }
}

async function fetchRaw(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const hasBody = options.body !== undefined && options.body !== null;
  const headers = new Headers(options.headers as HeadersInit | undefined);
  if (hasBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // Held in the browser only: a server render answers many people, and one person's wait is not another's.
  const read = typeof window !== 'undefined' && isRead(options.method) ? `${(options.method ?? 'GET').toUpperCase()} ${endpoint}` : undefined;
  const refusal = read === undefined ? null : heldRefusal(read);
  if (refusal) throw refusal;
  const res = await sendRequest(endpoint, {
    ...options,
    credentials: 'include',
    headers,
  });

  const refused = res.ok ? null : await errorOf(res, options.method, read);
  if (read !== undefined) noteAnswer(read, refused);
  if (refused) throw refused;

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
    throw await errorOf(res, 'PUT');
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
    throw await errorOf(res, 'POST');
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
