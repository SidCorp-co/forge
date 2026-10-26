import { type Holding, holding, readOnce, redactQueryParams } from './query-params.js';

export {
  asSerialized,
  errorsWithin,
  type FieldReads,
  type Holding,
  holding,
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

const SENSITIVE_KEY_PARTS = ['forwarded', '-ip', 'remote-', 'via', '-user'];

/**
 * What a Sentry client collects, set to the restrictive baseline every adapter here was built on.
 * Sentry 11 collects cookies, bodies, user info and query data when this is left unset, and the
 * scrub above covers none of the first three.
 */
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny: SENSITIVE_KEY_PARTS },
    response: { deny: SENSITIVE_KEY_PARTS },
  },
  httpBodies: [] as never[],
  urlQueryParams: { deny: SENSITIVE_KEY_PARTS },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
};

/** Sets a field in place, and says whether it now holds `value`: a fixed field refuses it. */
function put(target: object, key: string | number, value: unknown): boolean {
  try {
    // A setter of the caller's is never run: a field it guards is one this scrub cannot write.
    for (let at: object | null = target; at; at = Object.getPrototypeOf(at)) {
      const field = Object.getOwnPropertyDescriptor(at, key);
      if (field) {
        if (!('value' in field)) return false;
        break;
      }
    }
    (target as Record<string | number, unknown>)[key] = value;
  } catch {
    return false;
  }
  return Object.getOwnPropertyDescriptor(target, key)?.value === value;
}

/**
 * `holder[key]` read once and, where a getter answered, held there as data while `held` lasts, so a
 * hook rendering later reaches what was scrubbed; `null` where the read threw or cannot be held. A
 * primitive read only to look past it is left for the rendering to read after every scrub landed.
 */
function readField(
  holder: object,
  key: string,
  held: Holding | undefined,
  scrubbed: boolean,
): { value: unknown } | null {
  const read = readOnce(holder, key, held?.reads);
  if (read.threw) return null;
  if (!held || !read.called) return read;
  const object = typeof read.value === 'object' || typeof read.value === 'function';
  if (object || scrubbed) return held.hold(holder, key, read.value) ? read : null;
  held.reads.get(holder)?.delete(key);
  return read;
}

/** Scrubs every string in `obj` in place; false where a field refused the scrubbed text. */
export function scrubStringValues(obj: unknown, depth = 0, held?: Holding): boolean {
  if (depth > 8 || !obj) return true;
  // A function JSON renders through its toJSON holds fields as an object does.
  if (typeof obj !== 'object' && typeof obj !== 'function') return true;
  let whole = true;
  const keys = Array.isArray(obj) ? obj.map((_, i) => String(i)) : Object.keys(obj);
  for (const k of keys) {
    const field = readField(obj, k, held, true);
    if (!field) {
      whole = false;
      continue;
    }
    const v = field.value;
    if (typeof v === 'string') {
      const out = scrubPatInString(v);
      if (out !== v && !put(obj, k, out)) whole = false;
    } else if (!scrubStringValues(v, depth + 1, held)) whole = false;
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

/** A field's own data value with nothing in it: no secret to censor. A getter is never run to ask. */
function holdsNothing(obj: object, key: string): boolean {
  const field = Object.getOwnPropertyDescriptor(obj, key);
  if (!field || !('value' in field)) return false;
  const v: unknown = field.value;
  if (v === null || v === '') return true;
  // Only a plain container with nothing of its own: a `toJSON` could render it as anything.
  if (Array.isArray(v)) return Object.getPrototypeOf(v) === Array.prototype && Reflect.ownKeys(v).length === 1;
  return typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && Reflect.ownKeys(v).length === 0;
}

/** Key-named secrets in `obj` censored in place, an empty one left as it is: true only if each one held. */
export function scrubBodyKeys(obj: unknown, depth = 0, held?: Holding): boolean {
  if (depth > 8 || !obj || (typeof obj !== 'object' && typeof obj !== 'function')) return true;
  let whole = true;
  const array = Array.isArray(obj);
  const keys = array ? obj.map((_, i) => String(i)) : Object.keys(obj);
  for (const key of keys) {
    if (!array && (SCRUB_BODY_KEYS.has(key) || SCRUB_BODY_KEYS.has(key.toLowerCase()))) {
      if (!holdsNothing(obj, key) && !put(obj, key, FILTERED)) whole = false;
      continue;
    }
    const field = readField(obj, key, held, false);
    if (!field || !scrubBodyKeys(field.value, depth + 1, held)) whole = false;
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

/**
 * Where a value quoted `depth` escapes deep closes: the first quote behind as many backslashes as
 * its opening, plus any whole escaped pairs at that depth (`"`, `\"`, `\\\"` …). -1 where none does.
 */
function closingQuote(text: string, start: number, depth: number): number {
  for (let i = start; i < text.length && text[i] !== '\n'; i++) {
    if (quoteAt(text, i, start, depth)) return i - depth;
  }
  return -1;
}

/** Whether `text[i]` is a quote at `depth` escapes, opening or closing a string there. */
function quoteAt(text: string, i: number, from: number, depth: number): boolean {
  if (text[i] !== '"') return false;
  let slashes = 0;
  while (i - 1 - slashes >= from && text[i - 1 - slashes] === '\\') slashes++;
  return slashes >= depth && (slashes - depth) % (2 * (depth + 1)) === 0;
}

/**
 * The end of the array or object opening at `start`, quoted `depth` escapes deep, its brackets counted
 * outside the strings it holds; its line's end where they never close.
 */
function closingBracket(text: string, start: number, depth: number): number {
  let level = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoteAt(text, i, start, depth)) {
      const close = closingQuote(text, i + 1, depth);
      if (close < 0) return lineEnd(text, start);
      i = close + depth;
    } else if (ch === '[' || ch === '{') level++;
    else if (ch === ']' || ch === '}') {
      level--;
      if (level === 0) return i + 1;
    }
  }
  return lineEnd(text, start);
}

function lineEnd(text: string, from: number): number {
  const at = text.indexOf('\n', from);
  return at < 0 ? text.length : at;
}

const OPENING_QUOTE = /^(\\*)"/;
// What may end a value: a space or a delimiter; under a quoted name, where JSON holds it, a closing
// bracket or brace too, or a backslash escaping a closing quote or line break.
const ESCAPED_END = String.raw`\\+(?:"|[nrt](?![A-Za-z0-9]))`;
const ENDS = {
  quoted: String.raw`$|[\s,}\]&"]|${ESCAPED_END}`,
  unquoted: String.raw`$|[\s,&"]`,
};
const VALUE_END = {
  quoted: new RegExp(`^(?:${ENDS.quoted})`),
  unquoted: new RegExp(`^(?:${ENDS.unquoted})`),
};
// Only JSON types a value as empty or a literal; under an unquoted name `null` may be the password.
const KEPT_AS_IT_IS = {
  quoted: new RegExp(String.raw`^(?:\[\s*\]|\{\s*\}|null|true|false)(?=${ENDS.quoted})`),
  unquoted: /(?!)/,
};
// A backslash is the value's own, unless its run ends in a quote: that is the string around it closing.
const BARE_VALUE = /^(?:[^\s",}\]&\\]|\\+(?!\\*"))+/;
const BARE_UNQUOTED = /^(?:[^\s",&\\]|\\+(?!\\*"))+/;

/**
 * `text` with the value after each `name:` / `name=` replaced, read by its shape so JSON stays JSON
 * (ISS-1229 r45): a quoted value inside its own quotes, at any depth of escaping; an array or object
 * whole, as a quoted marker where the name was quoted; a bare value up to its delimiter. In JSON an
 * empty value, `null`, `true` and `false` hold no secret and are left as they are. `toLineEnd` is a header
 * line's rule: an unquoted value takes the rest of the line.
 */
function scrubNamedValues(text: string, name: string, toLineEnd: boolean): string {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b(\\\\*")?\\s*([:=])\\s*`, 'gi');
  let out = '';
  let from = 0;
  for (let found = re.exec(text); found; found = re.exec(text)) {
    const at = found.index + found[0].length;
    const nameQuote = found[1] ?? '';
    const context = nameQuote && found[2] === ':' ? 'quoted' : 'unquoted';
    const marker = `${nameQuote}${FILTERED}${nameQuote}`;
    const rest = text.slice(at);
    const quoted = OPENING_QUOTE.exec(rest);
    let end: number;
    let shown: string;
    if (quoted) {
      const opening = quoted[0];
      const close = closingQuote(text, at + opening.length, (quoted[1] as string).length);
      if (close === at + opening.length) continue;
      end = close < 0 ? lineEnd(text, at) : close + opening.length;
      shown = close < 0 ? `${opening}${FILTERED}` : `${opening}${FILTERED}${opening}`;
    } else if (toLineEnd) {
      end = lineEnd(text, at);
      shown = FILTERED;
    } else if (KEPT_AS_IT_IS[context].test(rest)) {
      continue;
    } else if (rest.startsWith('[') || rest.startsWith('{')) {
      end = closingBracket(text, at, Math.max(nameQuote.length - 1, 0));
      if (!VALUE_END[context].test(text.slice(end, end + 8))) end = at + (/^[^\s,&"]+/.exec(rest)?.[0].length ?? 0);
      shown = marker;
    } else {
      const bare = (nameQuote ? BARE_VALUE : BARE_UNQUOTED).exec(rest);
      if (!bare) continue;
      end = at + bare[0].length;
      shown = marker;
    }
    out += text.slice(from, at) + shown;
    from = end;
    re.lastIndex = end;
  }
  return out + text.slice(from);
}

export function scrubLogText(text: string, extraSecrets: string[] = []): string {
  let out = text
    .replace(PEM_PRIVATE_KEY_PATTERN, FILTERED)
    .replace(PEM_PRIVATE_KEY_HEAD_PATTERN, FILTERED)
    .split('\n')
    .map((line) => scrubPatInString(scrubUrl(line)))
    .join('\n');
  // Over the whole text, not line by line: an array or object JSON spreads over lines goes whole.
  for (const name of SCRUB_HEADER_KEYS) out = scrubNamedValues(out, name, true);
  for (const name of SCRUB_BODY_KEYS) out = scrubNamedValues(out, name, false);
  return out
    .split('\n')
    .map((line) => {
      let shown = line;
      for (const s of extraSecrets) {
        if (s && s.length >= 6) shown = shown.split(s).join(FILTERED);
      }
      return shown.replace(ENV_SECRET_ASSIGNMENT_PATTERN, `$1=${FILTERED}`);
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
  const held = holding();
  try {
    if (!scrubInPlace(event, held)) return null;
    const out = redactQueryParams(event, hint?.originalException, held.reads);
    if (out !== event && !scrubInPlace(out, holding())) return null;
    return out;
  } catch {
    return null;
  } finally {
    held.release();
  }
}

/** Headers, URL, body and breadcrumbs scrubbed, the pass `scrubSentryEvent` runs either side. */
function scrubInPlace(event: SentryLikeEvent, held: Holding): boolean {
  let whole = true;
  const keep = (done: boolean) => {
    if (!done) whole = false;
  };
  const at = (holder: object, key: string): unknown => {
    const field = readField(holder, key, held, true);
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
      keep(scrubBodyKeys(reqData, 0, held));
      keep(scrubStringValues(reqData, 0, held));
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
        keep(scrubBodyKeys(d, 0, held));
        keep(scrubStringValues(d, 0, held));
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
