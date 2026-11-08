/**
 * The one sign-in core makes with a testing profile's actor secret when it is written (ISS-937,
 * `project-config/secret-write.ts`): a POST of the account and password to the one sign-in URL the
 * secret and the judged deployment name, following no redirect, and read as
 * `forge-runner judge-login` reads it (`judge_login/session.rs:sign_in`). What it answers names a
 * status and a code the origin sent, never the body, the account or the password.
 */

export const SIGN_IN_TIMEOUT_MS = 10_000;
/**
 * Where a sign-in's answer may carry its bearer token, as JSON pointers: `token`, `accessToken`,
 * `access_token` or `jwt`, at the top or under `data` (Strapi and SidDesk answer `jwt`, SidDesk
 * under `data`; ISS-1094). judge-login reads the same list (`session.rs`: `TOKEN_PATHS`), held equal
 * by `project-config/actor-sign-in.test.ts`.
 */
export const TOKEN_PATHS = [
  '/token',
  '/accessToken',
  '/access_token',
  '/jwt',
  '/data/token',
  '/data/accessToken',
  '/data/access_token',
  '/data/jwt',
] as const;

/** What `body` holds at the JSON pointer `path`; undefined where it holds nothing there. */
function valueAt(body: unknown, path: string): unknown {
  let at: unknown = body;
  for (const raw of path.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    at = at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
  }
  return at;
}

/** The non-empty string `body` holds at the JSON pointer `path`, or null. */
export function tokenAt(body: unknown, path: string): string | null {
  const at = valueAt(body, path);
  return typeof at === 'string' && at !== '' ? at : null;
}

/** The token an answer carries at `tokenPath` where the secret names one (ISS-1141), else at the
 * first of `TOKEN_PATHS` holding a non-empty string. */
export function tokenIn(body: unknown, tokenPath?: string): string | null {
  if (tokenPath !== undefined) return tokenAt(body, tokenPath);
  for (const path of TOKEN_PATHS) {
    const token = tokenAt(body, path);
    if (token !== null) return token;
  }
  return null;
}

const TOKENS_SAID = '`token`, `accessToken`, `access_token` or `jwt`, at the top or under `data`';

/** What is sent: the account under the field its route reads, and the password; or, where the
 * secret describes its sign-in (ISS-1141), its `template` with each leaf that is exactly `$account`
 * or `$password` replaced, and the token read at its `tokenPath`. */
export interface SignInBody {
  field: string;
  account: string;
  password: string;
  template?: Record<string, unknown>;
  tokenPath?: string;
  /** The browser session the secret describes (ISS-1145): each `localStorage` key and the JSON
   * pointer into the answer its value is read at; the probe confirms each resolves. */
  storage?: Record<string, string>;
  /** The `localStorage` key the bearer token is stored under; the probe confirms there is one. */
  storageKey?: string;
}

/** The body a sign-in POSTs: whole leaves alone are replaced, so `$email` inside a string stays. */
export function signInBody(secret: SignInBody): Record<string, unknown> {
  if (!secret.template) return { [secret.field]: secret.account, password: secret.password };
  const fill = (v: unknown): unknown => {
    if (v === '$account') return secret.account;
    if (v === '$password') return secret.password;
    if (Array.isArray(v)) return v.map(fill);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, fill(inner)]));
    }
    return v;
  };
  return fill(secret.template) as Record<string, unknown>;
}

/** Whether a 2xx answer is a GraphQL error: an `errors` array with an entry. Its text is never read. */
function graphqlErrors(body: unknown): boolean {
  const errors =
    body !== null && typeof body === 'object' ? (body as { errors?: unknown }).errors : undefined;
  return Array.isArray(errors) && errors.length > 0;
}

/** A `tokenPath` as a refusal may say it: a pointer of short keys, else `the secret's \`tokenPath\``. */
function pathSaid(path: string): string {
  return /^(\/[A-Za-z0-9_-]{1,32}){1,8}$/.test(path) ? `\`${path}\`` : "the secret's `tokenPath`";
}

/** A `localStorage` key as a line may say it: in backticks when it is short and plain, else
 * "a key". judge-login says it the same way (`session/storage.rs`: `key_said`). */
export function keySaid(k: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(k) ? `\`${k}\`` : 'a key';
}

/** Why the answer cannot fill the browser session the secret describes (ISS-1145): the key and the
 * pointer it lacks, never a value; null where every key is filled. */
function storageGap(secret: SignInBody, body: unknown, bearer: boolean): string | null {
  if (secret.storageKey !== undefined && !bearer) {
    return "with no token to store under the secret's `storageKey`";
  }
  for (const [key, path] of Object.entries(secret.storage ?? {})) {
    const value = valueAt(body, path);
    if (value === undefined || value === null) {
      return `with nothing at ${pathSaid(path)} for the storage key ${keySaid(key)}, so the browser session the secret describes cannot be written`;
    }
  }
  return null;
}

/** A key, kind or code as a line may say it: a short identifier, never a value. */
export function shown(s: unknown): string | null {
  return typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(s) ? s : null;
}

/**
 * What the sign-in answered. `refused`: the origin answered and gave no session — a 4xx (but 408
 * and 429, which say "not now"), a redirect, or a success with no token and no cookie — so
 * judge-login would refuse the same value. `unconfirmed`: nothing was learned about the value —
 * the origin could not be reached, timed out, or answered 5xx, 408 or 429.
 */
export type SignInAnswer =
  | { answer: 'signs-in'; at: string; status: number }
  | { answer: 'refused'; at: string; status: number; code: string | null; says: string }
  | { answer: 'unconfirmed'; at: string; status: number | null; says: string };

function codeOf(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const error = o.error && typeof o.error === 'object' ? (o.error as Record<string, unknown>) : {};
  return shown(o.code) ?? shown(error.code);
}

function deletes(cookie: string): boolean {
  const age = /;\s*max-age\s*=\s*(-?\d+)/i.exec(cookie);
  return age !== null && Number(age[1]) <= 0;
}

/** Sign in at `url` with `secret`, following no redirect; the answer names a status and a code only. */
export async function trySignIn(secret: SignInBody, url: URL): Promise<SignInAnswer> {
  const at = `${url.origin}${url.pathname}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(signInBody(secret)),
      signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: unknown } }).cause?.code;
    const why = shown(cause) ?? shown((err as { name?: unknown }).name) ?? 'no answer';
    return { answer: 'unconfirmed', at, status: null, says: `could not be reached (${why})` };
  }
  const { status } = res;
  const body: unknown = await res.json().catch(() => null);
  const code = codeOf(body);
  if (status >= 500 || status === 408 || status === 429) {
    return {
      answer: 'unconfirmed',
      at,
      status,
      says: `answered ${status}${code ? ` ${code}` : ''}`,
    };
  }
  if (status >= 300 && status < 400) {
    return {
      answer: 'refused',
      at,
      status,
      code,
      says: `answered ${status}, a redirect, and a password is sent to no second origin; name the route it redirects to`,
    };
  }
  if (status >= 400) {
    return {
      answer: 'refused',
      at,
      status,
      code,
      says: `answered ${status}${code ? ` ${code}` : ''}`,
    };
  }
  if (graphqlErrors(body)) {
    return {
      answer: 'refused',
      at,
      status,
      code,
      says: `answered ${status} with a GraphQL \`errors\` array, so it signed nobody in`,
    };
  }
  const bearer = tokenIn(body, secret.tokenPath) !== null;
  if (secret.tokenPath !== undefined && !bearer) {
    return {
      answer: 'refused',
      at,
      status,
      code,
      says: `answered ${status} with no token at ${pathSaid(secret.tokenPath)}, so there is no session to hand a judge`,
    };
  }
  const cookie = res.headers.getSetCookie().some((c) => !deletes(c));
  if (!bearer && !cookie) {
    return {
      answer: 'refused',
      at,
      status,
      code,
      says: `answered ${status} with no token (${TOKENS_SAID}) and set no cookie, so there is no session to hand a judge`,
    };
  }
  const gap = storageGap(secret, body, bearer);
  if (gap !== null)
    return { answer: 'refused', at, status, code, says: `answered ${status} ${gap}` };
  return { answer: 'signs-in', at, status };
}
