import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { jwtVerify, SignJWT } from 'jose';
import type { ProviderId } from '../../integrations/identity/index.js';
import { env } from '../../lib/env.js';

const COOKIE_NAME = 'forge_oauth_state';
const COOKIE_TTL_SECONDS = 300; // 5 min — generous for slow auth screens
const ALG = 'HS256';
const ISSUER = 'forge.oauth.state';

type StateMode = 'login' | 'reauth';

interface StatePayload {
  /** Provider id this state belongs to. */
  p: ProviderId;
  /** The OAuth `state` the callback must echo. */
  s: string;
  /** The OIDC nonce the id_token must carry. */
  n: string;
  /** PKCE code_verifier. */
  v: string;
  /** Post-callback redirect path; always relative — never absolute URLs. */
  r: string;
  mode?: StateMode;
  /**
   * Authenticated user id captured at `reauth-start`. Only meaningful when
   * `mode === 'reauth'`. The HS256 signature prevents a client from forging
   * a `uid` here so we can trust the value at callback time.
   */
  uid?: string;
}

let cachedKey: Uint8Array | null = null;
function key(): Uint8Array {
  if (!cachedKey) cachedKey = new TextEncoder().encode(env.JWT_SECRET);
  return cachedKey;
}

export async function signState(payload: StatePayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_TTL_SECONDS}s`)
    .sign(key());
}

export async function verifyState(token: string): Promise<StatePayload> {
  const { payload } = await jwtVerify(token, key(), { issuer: ISSUER });
  if (
    typeof payload.p !== 'string' ||
    typeof payload.s !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.v !== 'string' ||
    typeof payload.r !== 'string'
  ) {
    throw new Error('state: malformed payload');
  }
  // mode defaults to 'login' for cookies issued before the reauth flow.
  const mode: StateMode = payload.mode === 'reauth' ? 'reauth' : 'login';
  const out: StatePayload = {
    p: payload.p as ProviderId,
    s: payload.s,
    n: payload.n,
    v: payload.v,
    r: payload.r,
    mode,
  };
  if (typeof payload.uid === 'string') out.uid = payload.uid;
  return out;
}

export function setStateCookie(c: Context, jwt: string): void {
  setCookie(c, COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test',
    sameSite: 'Lax',
    path: '/',
    maxAge: COOKIE_TTL_SECONDS,
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  });
}

export function clearStateCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: '/' });
  if (env.AUTH_COOKIE_DOMAIN) {
    deleteCookie(c, COOKIE_NAME, { path: '/', domain: env.AUTH_COOKIE_DOMAIN });
  }
}

export const STATE_COOKIE_NAME = COOKIE_NAME;
