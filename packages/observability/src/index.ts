// Canonical PII / auth scrubbing primitives. Imported by every Sentry
// adapter (dev renderer, core, web client + server) so the privacy
// contract is defined exactly once. Add new sensitive keys here, not
// in per-surface adapters.

/** Header names whose values must be replaced before send. Compared case-insensitively. */
export const SCRUB_HEADER_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'x-device-token',
  'x-api-key',
  'x-csrf-token',
]);

/** Object key names whose values must be replaced before send. Compared case-insensitively. */
export const SCRUB_BODY_KEYS: ReadonlySet<string> = new Set([
  'authToken',
  'auth_token',
  'apiKey',
  'api_key',
  'password',
  'secret',
  'jwt',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'sessionToken',
  'session_token',
  'bearerToken',
]);

/** Matches `?token=...` / `?jwt=...` / `?access_token=...` / `?api_key=...` query params. */
export const URL_TOKEN_PATTERN = /([?&](?:token|jwt|access_token|refresh_token|api_key)=)[^&#]+/gi;

export const FILTERED = '[Filtered]';

/** Mutates `obj` in place, replacing values whose keys appear in SCRUB_BODY_KEYS. Shallow only. */
export function scrubBodyKeys(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (SCRUB_BODY_KEYS.has(key) || SCRUB_BODY_KEYS.has(key.toLowerCase())) {
      (obj as Record<string, unknown>)[key] = FILTERED;
    }
  }
}

/** Mutates `headers` in place, replacing values whose keys appear in SCRUB_HEADER_KEYS. */
export function scrubHeaders(headers: Record<string, string | string[] | undefined>): void {
  for (const k of Object.keys(headers)) {
    if (SCRUB_HEADER_KEYS.has(k.toLowerCase())) {
      headers[k] = FILTERED;
    }
  }
}

/** Returns `url` with token-shaped query params replaced. */
export function scrubUrl(url: string): string {
  return url.replace(URL_TOKEN_PATTERN, `$1${FILTERED}`);
}

/**
 * Scrub a Sentry event in place. Covers request headers, request URL,
 * request body (string-JSON or object), and breadcrumb fetch URLs.
 * Generic over the event shape so this works across @sentry/react,
 * @sentry/node, and @sentry/nextjs.
 */
export function scrubSentryEvent<E extends SentryLikeEvent>(event: E): E {
  const req = event.request;
  if (req?.headers) scrubHeaders(req.headers);
  if (req?.url) req.url = scrubUrl(req.url);
  if (req?.data !== undefined && req.data !== null) {
    if (typeof req.data === 'string') {
      try {
        const parsed = JSON.parse(req.data);
        scrubBodyKeys(parsed);
        req.data = JSON.stringify(parsed);
      } catch {
        // not JSON — leave as-is
      }
    } else {
      scrubBodyKeys(req.data);
    }
  }
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (b.data && typeof b.data === 'object') {
        const d = b.data as Record<string, unknown>;
        if (typeof d.url === 'string') d.url = scrubUrl(d.url);
        scrubBodyKeys(d);
      }
    }
  }
  return event;
}

interface SentryLikeEvent {
  request?: {
    headers?: Record<string, string | string[] | undefined>;
    url?: string;
    data?: unknown;
  };
  breadcrumbs?: Array<{ data?: unknown }>;
}
