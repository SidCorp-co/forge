import { type FieldReads, readOnce, redactQueryParams } from './query-params.js';

export {
  asSerialized,
  errorsWithin,
  type FieldReads,
  isError,
  readOnce,
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

/**
 * `holder[key]` read once across `reads`, so what is scrubbed is what a later rendering answering
 * from the same reads writes; `null` where the read threw.
 */
function readField(holder: object, key: string, reads?: FieldReads): { value: unknown } | null {
  const read = readOnce(holder, key, reads);
  return read.threw ? null : read;
}

/** Scrubs every string in `obj` in place; false where a field refused the scrubbed text. */
export function scrubStringValues(obj: unknown, depth = 0, reads?: FieldReads): boolean {
  if (depth > 8 || !obj) return true;
  if (typeof obj !== 'object') return true;
  let whole = true;
  const keys = Array.isArray(obj) ? obj.map((_, i) => String(i)) : Object.keys(obj);
  for (const k of keys) {
    const field = readField(obj, k, reads);
    if (!field) {
      whole = false;
      continue;
    }
    const v = field.value;
    if (typeof v === 'string') {
      const out = scrubPatInString(v);
      if (out !== v && !put(obj, k, out)) whole = false;
    } else if (!scrubStringValues(v, depth + 1, reads)) whole = false;
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

/** Key-named secrets in `obj` censored in place: true only if each one held. */
export function scrubBodyKeys(obj: unknown, depth = 0, reads?: FieldReads): boolean {
  if (depth > 8 || !obj || typeof obj !== 'object') return true;
  let whole = true;
  const array = Array.isArray(obj);
  const keys = array ? obj.map((_, i) => String(i)) : Object.keys(obj);
  for (const key of keys) {
    if (!array && (SCRUB_BODY_KEYS.has(key) || SCRUB_BODY_KEYS.has(key.toLowerCase()))) {
      if (!put(obj, key, FILTERED)) whole = false;
      continue;
    }
    const field = readField(obj, key, reads);
    if (!field || !scrubBodyKeys(field.value, depth + 1, reads)) whole = false;
  }
  return whole;
}

/** Each secret-named header set to the filter marker; whether all of them took. */
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
 * A Sentry event scrubbed in place, so the event's own code renders nothing secret; then its failed
 * queries' params redacted (`redactQueryParams`, the hint's exception naming them) and the copy
 * scrubbed again. One it cannot scrub or read is dropped: `null` is `beforeSend`'s "do not send".
 */
export function scrubSentryEvent<E extends SentryLikeEvent>(
  event: E,
  hint?: { originalException?: unknown },
): E | null {
  const reads: FieldReads = new WeakMap();
  try {
    if (!scrubInPlace(event, reads)) return null;
    const out = redactQueryParams(event, hint?.originalException, reads);
    if (out !== event && !scrubInPlace(out, new WeakMap())) return null;
    return out;
  } catch {
    return null;
  }
}

/** Headers, URL, body and breadcrumbs scrubbed, the pass `scrubSentryEvent` runs either side. */
function scrubInPlace(event: SentryLikeEvent, reads: FieldReads): boolean {
  let whole = true;
  const keep = (done: boolean) => {
    if (!done) whole = false;
  };
  const at = (holder: object, key: string): unknown => {
    const field = readField(holder, key, reads);
    if (!field) whole = false;
    return field?.value;
  };
  const req = at(event, 'request') as SentryLikeEvent['request'];
  const headers = req && (at(req, 'headers') as Record<string, string | string[] | undefined>);
  if (headers) keep(scrubHeaders(headers));
  const reqUrl = req && at(req, 'url');
  if (req && typeof reqUrl === 'string') {
    const url = scrubPatInString(scrubUrl(reqUrl));
    if (url !== reqUrl) keep(put(req, 'url', url));
  }
  const reqData = req && at(req, 'data');
  if (req && reqData !== undefined && reqData !== null) {
    if (typeof reqData === 'string') {
      const rawData = reqData;
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
      keep(scrubBodyKeys(reqData, 0, reads));
      keep(scrubStringValues(reqData, 0, reads));
    }
  }
  const crumbs = at(event, 'breadcrumbs');
  if (Array.isArray(crumbs)) {
    for (const [i] of crumbs.entries()) {
      const b = at(crumbs, String(i)) as { message?: unknown; data?: unknown } | undefined;
      if (!b || typeof b !== 'object') continue;
      const text = at(b, 'message');
      if (typeof text === 'string') {
        const message = scrubPatInString(text);
        if (message !== text) keep(put(b, 'message', message));
      }
      const d = at(b, 'data');
      if (d && typeof d === 'object') {
        const dUrl = at(d, 'url');
        if (typeof dUrl === 'string') {
          const url = scrubPatInString(scrubUrl(dUrl));
          if (url !== dUrl) keep(put(d, 'url', url));
        }
        keep(scrubBodyKeys(d, 0, reads));
        keep(scrubStringValues(d, 0, reads));
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
