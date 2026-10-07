import { redactQueryParams } from './query-params.js';

export {
  asSerialized,
  errorsWithin,
  mayCarryBoundValues,
  REDACTED,
  redactedMessage,
  redactQueryParams,
  sealQueryError,
} from './query-params.js';

/** Header names whose values must be replaced before send. Compared case-insensitively. */
export const SCRUB_HEADER_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'x-device-token',
  'x-api-key',
  'x-csrf-token',
]);

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
  'testCredentials',
  // ISS-1036 — a GitHub App's PEM and a Google service-account key file. Both
  // are credentials with no token-shaped signature of their own, so the key
  // name is the only thing that identifies them in a structured payload.
  'privateKey',
  'private_key',
  'serviceAccountJson',
  'service_account_json',
]);

/** Matches `?token=...` / `?jwt=...` / `?access_token=...` / `?api_key=...` query params. */
export const URL_TOKEN_PATTERN = /([?&](?:token|jwt|access_token|refresh_token|api_key)=)[^&#]+/gi;

/**
 * ISS-150 — PAT plaintext shape (`forge_pat_<env>_<hex>`). Unanchored and
 * global so we can redact tokens that leak inside larger strings — query
 * params, JSON bodies, breadcrumb messages.
 */
export const PAT_STRING_PATTERN = /forge_pat_(?:dev|stg|prd)_[A-Fa-f0-9]+/g;

export const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----/g;

export const PEM_PRIVATE_KEY_HEAD_PATTERN =
  /-----BEGIN (?:[A-Z]{1,12} ){0,3}PRIVATE KEY-----(?:\\n|\s)*(?:[A-Za-z0-9+/=]{16,}(?:(?:\\n|\s)+[A-Za-z0-9+/=]{16,})*)?/g;

/**
 * ISS-1036 — a Google OAuth2 access token, the thing Forge mints from a
 * service-account key. Redacted for the same reason the key is: a token that
 * reaches a log is a live credential for its hour.
 */
export const GOOGLE_ACCESS_TOKEN_PATTERN = /ya29\.[A-Za-z0-9_\-.]+/g;

export const ENV_SECRET_ASSIGNMENT_PATTERN =
  /^(\s*(?:export\s+)?(?:[A-Z0-9]+_)*(?:PASSWORD|SECRET|TOKEN|KEY|PASS|PEPPER|DSN|CREDENTIALS)(?:_[A-Z0-9]+)*)\s*=\s*\S.*$/;

export const FILTERED = '[Filtered]';

/** Sets a field in place, and says whether it now holds `value`: a fixed field refuses it. */
function put(target: object, key: string | number, value: unknown): boolean {
  try {
    (target as Record<string | number, unknown>)[key] = value;
  } catch {
    return false;
  }
  return Object.getOwnPropertyDescriptor(target, key)?.value === value;
}

/** Scrubs every string in `obj` in place; false where a field refused the scrubbed text. */
export function scrubStringValues(obj: unknown, depth = 0): boolean {
  if (depth > 8 || !obj) return true;
  if (typeof obj !== 'object') return true;
  let whole = true;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      if (typeof v === 'string') {
        const out = scrubPatInString(v);
        if (out !== v && !put(obj, i, out)) whole = false;
      } else if (!scrubStringValues(v, depth + 1)) whole = false;
    }
    return whole;
  }
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (typeof v === 'string') {
      const out = scrubPatInString(v);
      if (out !== v && !put(rec, k, out)) whole = false;
    } else if (!scrubStringValues(v, depth + 1)) whole = false;
  }
  return whole;
}

/** Redact PAT plaintext inside a single string (URL, log line, breadcrumb message). */
/**
 * Replace every secret-SHAPED run in `s` — a Forge PAT, a PEM private key, a
 * Google access token. Named for the PAT it started as; it now carries every
 * pattern whose SHAPE identifies it without a key name beside it, so one call
 * covers a value wherever it turns up.
 */
export function scrubPatInString(s: string): string {
  return s
    .replace(PAT_STRING_PATTERN, FILTERED)
    .replace(PEM_PRIVATE_KEY_PATTERN, FILTERED)
    .replace(PEM_PRIVATE_KEY_HEAD_PATTERN, FILTERED)
    .replace(GOOGLE_ACCESS_TOKEN_PATTERN, FILTERED);
}

/** Censors every key-named secret in `obj` in place; false where a field refused it. */
export function scrubBodyKeys(obj: unknown, depth = 0): boolean {
  if (depth > 8 || !obj || typeof obj !== 'object') return true;
  let whole = true;
  if (Array.isArray(obj)) {
    for (const item of obj) if (!scrubBodyKeys(item, depth + 1)) whole = false;
    return whole;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (SCRUB_BODY_KEYS.has(key) || SCRUB_BODY_KEYS.has(key.toLowerCase())) {
      if (!put(rec, key, FILTERED)) whole = false;
      continue;
    }
    if (!scrubBodyKeys(rec[key], depth + 1)) whole = false;
  }
  return whole;
}

/** Censors every secret-named header in place; false where a header refused it. */
export function scrubHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  let whole = true;
  for (const k of Object.keys(headers)) {
    if (SCRUB_HEADER_KEYS.has(k.toLowerCase()) && !put(headers, k, FILTERED)) whole = false;
  }
  return whole;
}

/** Returns `url` with token-shaped query params replaced. */
export function scrubUrl(url: string): string {
  return url.replace(URL_TOKEN_PATTERN, `$1${FILTERED}`);
}

/** Escape a string for safe interpolation into a `RegExp` source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scrubLogText(text: string, extraSecrets: string[] = []): string {
  const headerKeys = Array.from(SCRUB_HEADER_KEYS).map(escapeRegExp).join('|');
  const headerRe = new RegExp(`\\b(${headerKeys})(\\s*[:=]\\s*).+`, 'gi');
  // Value stops at whitespace, quote, comma, brace, or `&` — the `&` guard
  // keeps a key=value match from swallowing the rest of a URL query string
  // (e.g. `access_token=...&id=7` must not lose the `&id=7`).
  const bodyRes = Array.from(SCRUB_BODY_KEYS).map(
    (k) => new RegExp(`(\\b${escapeRegExp(k)}\\b\\s*[:=]\\s*"?)([^\\s",}&]+)`, 'gi'),
  );
  return text
    .replace(PEM_PRIVATE_KEY_PATTERN, FILTERED)
    .replace(PEM_PRIVATE_KEY_HEAD_PATTERN, FILTERED)
    .split('\n')
    .map((line) => {
      let out = scrubPatInString(scrubUrl(line));
      out = out.replace(headerRe, `$1$2${FILTERED}`);
      for (const re of bodyRes) out = out.replace(re, `$1${FILTERED}`);
      for (const s of extraSecrets) {
        if (s && s.length >= 6) out = out.split(s).join(FILTERED);
      }
      out = out.replace(ENV_SECRET_ASSIGNMENT_PATTERN, `$1=${FILTERED}`);
      return out;
    })
    .join('\n');
}

/**
 * Scrub a Sentry event: request headers, URL, body and breadcrumbs in place, so a key-named secret
 * is censored before any of the event's own code renders it; then a failed query's bound params
 * anywhere in it, the hint's exception naming them, which also renders whatever a serializer would
 * call into plain fields (a copy where anything changed); then the same scrub over that copy, for
 * a secret only the rendering showed. An event holding a secret a fixed field will not give up is
 * dropped (`null`, which `beforeSend` reads as "do not send"), never sent with it. Generic over the
 * event shape so this works across @sentry/react, @sentry/node, and @sentry/nextjs.
 */
export function scrubSentryEvent<E extends SentryLikeEvent>(
  event: E,
  hint?: { originalException?: unknown },
): E | null {
  if (!scrubInPlace(event)) return null;
  const out = redactQueryParams(event, hint?.originalException);
  if (out !== event && !scrubInPlace(out)) return null;
  return out;
}

/** The event's request and breadcrumbs scrubbed in place; false where a field refused it. */
function scrubInPlace(event: SentryLikeEvent): boolean {
  let whole = true;
  const keep = (done: boolean) => {
    if (!done) whole = false;
  };
  const req = event.request;
  if (req?.headers) keep(scrubHeaders(req.headers));
  if (typeof req?.url === 'string') {
    const url = scrubPatInString(scrubUrl(req.url));
    if (url !== req.url) keep(put(req, 'url', url));
  }
  if (req && req.data !== undefined && req.data !== null) {
    if (typeof req.data === 'string') {
      const rawData = req.data;
      let data: string;
      try {
        const parsed = JSON.parse(rawData);
        scrubBodyKeys(parsed);
        scrubStringValues(parsed);
        data = JSON.stringify(parsed);
      } catch {
        // not JSON — still scan for raw PAT plaintext.
        data = scrubPatInString(rawData);
      }
      if (data !== rawData) keep(put(req, 'data', data));
    } else {
      keep(scrubBodyKeys(req.data));
      keep(scrubStringValues(req.data));
    }
  }
  if (Array.isArray(event.breadcrumbs)) {
    for (const b of event.breadcrumbs) {
      if (typeof b?.message === 'string') {
        const message = scrubPatInString(b.message);
        if (message !== b.message) keep(put(b, 'message', message));
      }
      if (b?.data && typeof b.data === 'object') {
        const d = b.data as Record<string, unknown>;
        if (typeof d.url === 'string') {
          const url = scrubPatInString(scrubUrl(d.url));
          if (url !== d.url) keep(put(d, 'url', url));
        }
        keep(scrubBodyKeys(d));
        keep(scrubStringValues(d));
      }
    }
  }
  return whole;
}

interface SentryLikeEvent {
  request?: {
    headers?: Record<string, string | string[] | undefined>;
    url?: string;
    data?: unknown;
  };
  breadcrumbs?: Array<{ message?: string; data?: unknown }>;
}

const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/** The commit a build was told it was made from, or `null` for anything that is not one. */
export function parseSourceCommit(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && SOURCE_COMMIT_PATTERN.test(value) ? value : null;
}
