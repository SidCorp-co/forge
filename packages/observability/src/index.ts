
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

export function scrubStringValues(obj: unknown, depth = 0): void {
  if (depth > 8 || !obj) return;
  if (typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      if (typeof v === 'string') obj[i] = scrubPatInString(v);
      else scrubStringValues(v, depth + 1);
    }
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (typeof v === 'string') rec[k] = scrubPatInString(v);
    else scrubStringValues(v, depth + 1);
  }
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

const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/** The commit a build was told it was made from, or `null` for anything that is not one. */
export function parseSourceCommit(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && SOURCE_COMMIT_PATTERN.test(value) ? value : null;
}
