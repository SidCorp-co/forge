/**
 * Shared OAuth flow — handles both /:provider/start and /:provider/callback.
 * Provider-specific logic lives in integrations/identity (github.ts, oidc.ts); this file
 * is the connective tissue (cookie state, find-or-create-user, set the
 * auth cookie, redirect).
 */

import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { setAuthCookie } from '../../credentials/cookie.js';
import { signUserToken } from '../../credentials/jwt.js';
import { db } from '../../db/client.js';
import { oauthAccounts, users } from '../../db/schema.js';
import {
  githubProvider,
  googleProvider,
  type OAuthIdentity,
  type OAuthProvider,
  oidcProvider,
  type ProviderConfig,
  type ProviderId,
} from '../../integrations/identity/index.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { invalid } from '../../middleware/zod-validator.js';
import { ensurePersonalOrg } from '../../orgs/index.js';
import { assertNotAgentUser } from '../agent-login-gate.js';
import { getCallbackUrl, getProvider } from './providers.js';
import {
  clearStateCookie,
  STATE_COOKIE_NAME,
  setStateCookie,
  signState,
  verifyState,
} from './state.js';

const providerImpls: Record<ProviderId, OAuthProvider> = {
  github: githubProvider,
  google: googleProvider,
  oidc: oidcProvider,
};

function safeRedirect(raw: string | undefined | null): string {
  // Only allow same-origin relative paths to defeat open-redirect attacks.
  if (!raw?.startsWith('/') || raw.startsWith('//')) return '/projects';
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

export const startQuery = z.object({ redirect: z.string().optional() });

type StartQuery = z.infer<typeof startQuery>;

export const refuseStartQuery = invalid('redirect takes one same-origin path');

// the provider redirects here and adds keys of its own (Google: scope, authuser, prompt, hd)
export const callbackQuery = z.looseObject({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

type CallbackQuery = z.infer<typeof callbackQuery>;

export const refuseCallbackQuery = (result: { success: boolean }, c: Context) => {
  if (!result.success) return oauthErrorRedirect(c, 'provider_error');
};

interface StartOptions {
  /** `login` (default) or `reauth`. Persisted on the state cookie. */
  mode?: 'login' | 'reauth';
  /** Authenticated user id — required when `mode === 'reauth'`. */
  uid?: string;
}

export async function handleStart(
  c: Context,
  providerId: ProviderId,
  query: StartQuery,
  options: StartOptions = {},
) {
  const cfg = getProvider(providerId);
  if (!cfg) {
    throw new HTTPException(404, {
      message: `provider ${providerId} not enabled`,
      cause: { code: 'PROVIDER_NOT_ENABLED' },
    });
  }
  const { url, checks } = await providerImpls[providerId].start(cfg, getCallbackUrl(providerId));
  const target = safeRedirect(query.redirect);

  const cookieJwt = await signState({
    p: providerId,
    s: checks.state,
    n: checks.nonce,
    v: checks.codeVerifier,
    r: target,
    mode: options.mode ?? 'login',
    ...(options.uid ? { uid: options.uid } : {}),
  });
  setStateCookie(c, cookieJwt);

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

  if (!identity.email || !identity.emailVerified) {
    throw new HTTPException(400, {
      message: 'OAuth provider did not return a verified email',
      cause: { code: 'EMAIL_UNVERIFIED' },
    });
  }

  const email = identity.email;
  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });
    if (!user) throw new Error('oauth: user insert returned no row');
    await tx.insert(oauthAccounts).values({
      userId: user.id,
      provider: cfg.id,
      providerAccountId: identity.providerAccountId,
      email,
    });
    await ensurePersonalOrg(tx, user.id, email);
    return user;
  });
  logger.info({ userId: created.id, provider: cfg.id }, 'oauth: created new user');
  return { userId: created.id };
}

export async function handleCallback(c: Context, providerId: ProviderId, query: CallbackQuery) {
  const cfg = getProvider(providerId);
  if (!cfg) {
    throw new HTTPException(404, {
      message: `provider ${providerId} not enabled`,
      cause: { code: 'PROVIDER_NOT_ENABLED' },
    });
  }
  const { code, state, error } = query;
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

  let payload: Awaited<ReturnType<typeof verifyState>>;
  try {
    payload = await verifyState(cookieJwt);
  } catch {
    clearStateCookie(c);
    return oauthErrorRedirect(c, 'session_expired');
  }
  if (payload.p !== providerId || payload.s !== state) {
    clearStateCookie(c);
    return oauthErrorRedirect(c, 'session_expired');
  }
  // Single-use — burn the cookie before doing anything that might fail so a
  // network blip on the token exchange can't leave a replayable state.
  clearStateCookie(c);

  // The registered callback URL, not the request's own: behind a proxy the request sees an
  // internal host, and the token exchange must name the redirect_uri the provider was given.
  const callbackUrl = new URL(getCallbackUrl(providerId));
  callbackUrl.search = new URL(c.req.url).search;
  const identity = await providerImpls[providerId].finish(cfg, {
    callbackUrl,
    checks: { state: payload.s, nonce: payload.n, codeVerifier: payload.v },
  });

  const appBase = env.APP_BASE_URL.replace(/\/+$/, '');

  if (payload.mode === 'reauth') {
    return handleReauthCallback(
      c,
      providerId,
      payload.uid,
      identity.providerAccountId,
      payload.r,
      appBase,
    );
  }

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

  await assertNotAgentUser(userId);
  const token = await signUserToken(userId);
  setAuthCookie(c, token);

  // Build the post-callback URL against `APP_BASE_URL` — the web frontend
  // origin, NOT the API origin. A bare `c.redirect("/projects")` resolves
  // relative to the current host (the API), landing the user on
  // localhost:8080/projects which has no Next.js. `payload.r` was already
  // narrowed to a safe relative path at /start.
  const target = `${appBase}${payload.r}`;
  return c.redirect(target, 302);
}

async function handleReauthCallback(
  c: Context,
  providerId: ProviderId,
  uid: string | undefined,
  providerAccountId: string,
  returnPath: string,
  appBase: string,
): Promise<Response> {
  // `returnPath` may already carry a query string (web-v2 settings tabs are
  // `/settings?tab=tokens`), so the reauth outcome param can't be blindly
  // `?`-appended.
  const withParam = (param: string): string =>
    `${appBase}${returnPath}${returnPath.includes('?') ? '&' : '?'}${param}`;

  // `uid` rides inside the signed state cookie; missing means the cookie was
  // issued by an older /start flow without reauth metadata. Treat as a hard
  // mismatch — we will not silently fall back to login mode.
  const mismatch = (): Response => c.redirect(withParam('reauth_error=identity_mismatch'), 302);

  if (!uid) {
    logger.info({ provider: providerId }, 'oauth reauth: missing uid in state');
    return mismatch();
  }

  const [linked] = await db
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .where(
      and(
        eq(oauthAccounts.provider, providerId),
        eq(oauthAccounts.providerAccountId, providerAccountId),
      ),
    )
    .limit(1);

  if (!linked || linked.userId !== uid) {
    logger.info(
      { provider: providerId, expectedUserId: uid, actualUserId: linked?.userId ?? null },
      'oauth reauth: identity mismatch',
    );
    return mismatch();
  }

  await db.update(users).set({ lastFreshAuthAt: new Date() }).where(eq(users.id, uid));

  // Important: do NOT setAuthCookie() here — the user is already logged in.
  // A successful reauth must not escalate to a new session.
  return c.redirect(withParam('reauth=ok'), 302);
}
