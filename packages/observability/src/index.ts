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
  // ISS-225 — previewDeploy.testCredentials[] carries QA login pairs.
  'testCredentials',
]);

/** Matches `?token=...` / `?jwt=...` / `?access_token=...` / `?api_key=...` query params. */
export const URL_TOKEN_PATTERN = /([?&](?:token|jwt|access_token|refresh_token|api_key)=)[^&#]+/gi;

/**
 * ISS-150 — PAT plaintext shape (`forge_pat_<env>_<hex>`). Unanchored and
 * global so we can redact tokens that leak inside larger strings — query
 * params, JSON bodies, breadcrumb messages.
 */
export const PAT_STRING_PATTERN = /forge_pat_(?:dev|stg|prd)_[A-Fa-f0-9]+/g;

export const FILTERED = '[Filtered]';

/**
 * Walk every string value in `obj` (recursively, depth-limited) and replace
 * matches of {@link PAT_STRING_PATTERN} with `[Filtered]`. Sentry payloads
 * are arbitrarily nested; we bound recursion to avoid pathological loops on
 * cyclic objects.
 */
export function scrubStringValues(obj: unknown, depth = 0): void {
  if (depth > 8 || !obj) return;
  if (typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      if (typeof v === 'string') obj[i] = v.replace(PAT_STRING_PATTERN, FILTERED);
      else scrubStringValues(v, depth + 1);
    }
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (typeof v === 'string') rec[k] = v.replace(PAT_STRING_PATTERN, FILTERED);
    else scrubStringValues(v, depth + 1);
  }
}

/** Redact PAT plaintext inside a single string (URL, log line, breadcrumb message). */
export function scrubPatInString(s: string): string {
  return s.replace(PAT_STRING_PATTERN, FILTERED);
}

/**
 * Mutates `obj` in place, replacing values whose keys appear in
 * SCRUB_BODY_KEYS. Walks nested objects and arrays depth-limited (≤ 8) so
 * deeply-nested secrets like `previewDeploy.testCredentials[]` get redacted
 * too. Matched subtrees are replaced with `[Filtered]` outright — we do not
 * recurse INTO a redacted subtree.
 */
export function scrubBodyKeys(obj: unknown, depth = 0): void {
  if (depth > 8 || !obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) scrubBodyKeys(item, depth + 1);
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (SCRUB_BODY_KEYS.has(key) || SCRUB_BODY_KEYS.has(key.toLowerCase())) {
      rec[key] = FILTERED;
      continue;
    }
    scrubBodyKeys(rec[key], depth + 1);
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

/** Escape a string for safe interpolation into a `RegExp` source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Line-oriented secret scrubbing for free-form log text (e.g. a Coolify
 * build/deploy log surfaced over MCP). Unlike {@link scrubSentryEvent}, which
 * walks structured event objects, this redacts secret-SHAPED tokens inside
 * arbitrary text while preserving the surrounding diagnostic signal.
 *
 * Reuses the same canonical key sets as the rest of this module:
 *  - {@link PAT_STRING_PATTERN} (Forge PAT plaintext) and {@link URL_TOKEN_PATTERN}
 *    (tokenized URL query params).
 *  - {@link SCRUB_HEADER_KEYS}: `Authorization: Bearer xxx`, `Cookie: ...`, etc.
 *  - {@link SCRUB_BODY_KEYS}: `token=...`, `"apiKey":"..."`, `password=...`, ...
 *  - `extraSecrets`: literal secret VALUES known to the caller (e.g. the
 *    integration's own `apiToken` / `previousApiToken`), redacted wholesale.
 *
 * CRITICAL: redaction is token-scoped — we replace only the secret value, never
 * the whole line. Whole-line masking of `ENV`/`ARG`/stderr would swallow the
 * very diagnostic the log is being read for (ISS-277: `Cannot find module
 * '@codemirror/state'`). Short `extraSecrets` (< 6 chars) are ignored to avoid
 * shredding the log with spurious matches.
 */
export function scrubLogText(text: string, extraSecrets: string[] = []): string {
  // Header value is the REST of the line (we scrub per line), so `Authorization:
  // Bearer <token>` redacts the whole credential, not just the `Bearer` word.
  const headerKeys = Array.from(SCRUB_HEADER_KEYS).map(escapeRegExp).join('|');
  const headerRe = new RegExp(`\\b(${headerKeys})(\\s*[:=]\\s*).+`, 'gi');
  // Value stops at whitespace, quote, comma, brace, or `&` — the `&` guard
  // keeps a key=value match from swallowing the rest of a URL query string
  // (e.g. `access_token=...&id=7` must not lose the `&id=7`).
  const bodyRes = Array.from(SCRUB_BODY_KEYS).map(
    (k) => new RegExp(`(\\b${escapeRegExp(k)}\\b\\s*[:=]\\s*"?)([^\\s",}&]+)`, 'gi'),
  );
  return text
    .split('\n')
    .map((line) => {
      let out = scrubPatInString(scrubUrl(line));
      out = out.replace(headerRe, `$1$2${FILTERED}`);
      for (const re of bodyRes) out = out.replace(re, `$1${FILTERED}`);
      for (const s of extraSecrets) {
        if (s && s.length >= 6) out = out.split(s).join(FILTERED);
      }
      return out;
    })
    .join('\n');
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
  if (req?.url) req.url = scrubPatInString(scrubUrl(req.url));
  if (req?.data !== undefined && req.data !== null) {
    if (typeof req.data === 'string') {
      const rawData = req.data;
      try {
        const parsed = JSON.parse(rawData);
        scrubBodyKeys(parsed);
        scrubStringValues(parsed);
        req.data = JSON.stringify(parsed);
      } catch {
        // not JSON — still scan for raw PAT plaintext.
        req.data = scrubPatInString(rawData);
      }
    } else {
      scrubBodyKeys(req.data);
      scrubStringValues(req.data);
    }
  }
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (typeof b.message === 'string') b.message = scrubPatInString(b.message);
      if (b.data && typeof b.data === 'object') {
        const d = b.data as Record<string, unknown>;
        if (typeof d.url === 'string') d.url = scrubPatInString(scrubUrl(d.url));
        scrubBodyKeys(d);
        scrubStringValues(d);
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
  breadcrumbs?: Array<{ message?: string; data?: unknown }>;
}
