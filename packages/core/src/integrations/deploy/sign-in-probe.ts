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

/** The token an answer carries at the first of `TOKEN_PATHS` holding a non-empty string. */
export function tokenIn(body: unknown): string | null {
  for (const path of TOKEN_PATHS) {
    let at: unknown = body;
    for (const key of path.slice(1).split('/')) {
      at = at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
    }
    if (typeof at === 'string' && at !== '') return at;
  }
  return null;
}

const TOKENS_SAID = '`token`, `accessToken`, `access_token` or `jwt`, at the top or under `data`';

/** What is sent: the account under the field its route reads, and the password. */
export interface SignInBody {
  field: string;
  account: string;
  password: string;
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
      body: JSON.stringify({ [secret.field]: secret.account, password: secret.password }),
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
  const bearer = tokenIn(body) !== null;
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
  return { answer: 'signs-in', at, status };
}
