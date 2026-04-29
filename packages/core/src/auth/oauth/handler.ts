/**
 * Shared OAuth flow — handles both /:provider/start and /:provider/callback.
 * Provider-specific logic lives in github.ts / oidc-provider.ts; this file
 * is the connective tissue (cookie state, find-or-create-user, set the
 * auth cookie, redirect).
 */

import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getCookie } from 'hono/cookie';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { oauthAccounts, users } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { setAuthCookie } from '../cookie.js';
import { signUserToken } from '../jwt.js';
import { githubProvider } from './github.js';
import { googleProvider, oidcProvider } from './oidc-provider.js';
import {
  type ProviderConfig,
  type ProviderId,
  getCallbackUrl,
  getProvider,
} from './providers.js';
import {
  STATE_COOKIE_NAME,
  clearStateCookie,
  generateNonce,
  generatePkceVerifier,
  pkceChallenge,
  setStateCookie,
  signState,
  verifyState,
} from './state.js';
import type { OAuthIdentity, OAuthProvider } from './types.js';

const providerImpls: Record<ProviderId, OAuthProvider> = {
  github: githubProvider,
  google: googleProvider,
  oidc: oidcProvider,
};

function safeRedirect(raw: string | undefined | null): string {
  // Only allow same-origin relative paths to defeat open-redirect attacks.
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/projects';
  return raw;
}

/**
 * Redirect back to the web `/login` with a typed error code so the page can
 * render a friendly banner instead of leaving the user on a raw 400 JSON.
 * Codes are stable identifiers (not human prose) — translation lives in the
 * web layer.
 */
function oauthErrorRedirect(c: Context, code: string): Response {
  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  return c.redirect(`${base}/login?oauth_error=${encodeURIComponent(code)}`, 302);
}

export async function handleStart(c: Context, providerId: ProviderId) {
  const cfg = getProvider(providerId);
  if (!cfg) {
    throw new HTTPException(404, {
      message: `provider ${providerId} not enabled`,
      cause: { code: 'PROVIDER_NOT_ENABLED' },
    });
  }
  const impl = providerImpls[providerId];
  const redirectUri = getCallbackUrl(providerId);
  const nonce = generateNonce();
  const verifier = generatePkceVerifier();
  const challenge = await pkceChallenge(verifier);
  const target = safeRedirect(c.req.query('redirect'));

  const cookieJwt = await signState({ p: providerId, n: nonce, v: verifier, r: target });
  setStateCookie(c, cookieJwt);

  const url = await impl.buildAuthorizeUrl(cfg, {
    state: nonce,
    codeChallenge: challenge,
    nonce,
    redirectUri,
  });
  return c.redirect(url, 302);
}

async function findOrCreateUser(
  cfg: ProviderConfig,
  identity: OAuthIdentity,
): Promise<{ userId: string }> {
  // 1. Direct match by (provider, providerAccountId) → already linked.
  const [linked] = await db
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .where(
      and(
        eq(oauthAccounts.provider, cfg.id),
        eq(oauthAccounts.providerAccountId, identity.providerAccountId),
      ),
    )
    .limit(1);
  if (linked) return { userId: linked.userId };

  // 2. Auto-link by email — only if the provider claims the email is
  //    verified. Without that we'd let an attacker register an OAuth
  //    account spoofing someone else's email and seize their local user.
  if (identity.email && identity.emailVerified) {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, identity.email))
      .limit(1);
    if (existing) {
      await db.insert(oauthAccounts).values({
        userId: existing.id,
        provider: cfg.id,
        providerAccountId: identity.providerAccountId,
        email: identity.email,
      });
      logger.info(
        { userId: existing.id, provider: cfg.id },
        'oauth: auto-linked by verified email',
      );
      return { userId: existing.id };
    }
  }

  // 3. New user. We require a verified email to create one — if the
  //    provider can't vouch for the address, we refuse rather than store
  //    half a user. The frontend surfaces this as "email_unverified".
  if (!identity.email || !identity.emailVerified) {
    throw new HTTPException(400, {
      message: 'OAuth provider did not return a verified email',
      cause: { code: 'EMAIL_UNVERIFIED' },
    });
  }

  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: identity.email!,
        // No local password — passwordHash defaults NULL since 0037.
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });
    if (!user) throw new Error('oauth: user insert returned no row');
    await tx.insert(oauthAccounts).values({
      userId: user.id,
      provider: cfg.id,
      providerAccountId: identity.providerAccountId,
      email: identity.email,
    });
    return user;
  });
  logger.info({ userId: created.id, provider: cfg.id }, 'oauth: created new user');
  return { userId: created.id };
}

export async function handleCallback(c: Context, providerId: ProviderId) {
  const cfg = getProvider(providerId);
  if (!cfg) {
    throw new HTTPException(404, {
      message: `provider ${providerId} not enabled`,
      cause: { code: 'PROVIDER_NOT_ENABLED' },
    });
  }
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  // User-recoverable error paths redirect back to /login with a typed code
  // so the web banner can give a useful message. Operator-misconfiguration
  // paths (PROVIDER_NOT_ENABLED above) keep their HTTP error since the user
  // can't fix them by retrying.
  if (error) {
    return oauthErrorRedirect(c, error === 'access_denied' ? 'denied' : 'provider_error');
  }
  if (!code || !state) {
    return oauthErrorRedirect(c, 'provider_error');
  }
  const cookieJwt = getCookie(c, STATE_COOKIE_NAME);
  if (!cookieJwt) {
    return oauthErrorRedirect(c, 'session_expired');
  }

  let payload;
  try {
    payload = await verifyState(cookieJwt);
  } catch {
    clearStateCookie(c);
    return oauthErrorRedirect(c, 'session_expired');
  }
  if (payload.p !== providerId || payload.n !== state) {
    clearStateCookie(c);
    return oauthErrorRedirect(c, 'session_expired');
  }
  // Single-use — burn the cookie before doing anything that might fail so a
  // network blip on the token exchange can't leave a replayable state.
  clearStateCookie(c);

  const impl = providerImpls[providerId];
  const redirectUri = getCallbackUrl(providerId);
  const identity = await impl.callback(cfg, {
    code,
    codeVerifier: payload.v,
    nonce: payload.n,
    redirectUri,
  });

  let userId: string;
  try {
    ({ userId } = await findOrCreateUser(cfg, identity));
  } catch (err) {
    const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
    if (causeCode === 'EMAIL_UNVERIFIED') {
      return oauthErrorRedirect(c, 'email_unverified');
    }
    throw err;
  }

  const token = await signUserToken(userId);
  setAuthCookie(c, token);

  // Build the post-callback URL against `APP_BASE_URL` — the web frontend
  // origin, NOT the API origin. A bare `c.redirect("/projects")` resolves
  // relative to the current host (the API), landing the user on
  // localhost:8080/projects which has no Next.js. `payload.r` was already
  // narrowed to a safe relative path at /start.
  const target = `${env.APP_BASE_URL.replace(/\/+$/, '')}${payload.r}`;
  return c.redirect(target, 302);
}
