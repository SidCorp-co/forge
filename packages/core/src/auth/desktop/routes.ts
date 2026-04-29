/**
 * Desktop OAuth handoff — RFC 8252 (OAuth 2.0 for Native Apps) +
 * RFC 7636 (PKCE) applied to the cross-process problem of "how does the
 * Tauri client receive a Forge JWT after the user completes web OAuth?"
 *
 * See ADR 0017 for the threat model and rejected alternatives. The short
 * version: token is never put in a URL — only a one-time `code` that is
 * useless without the `code_verifier` the desktop kept in memory.
 *
 *   1.  GET  /api/auth/desktop/start       — desktop opens this in browser
 *   2.  POST /api/auth/desktop/issue-code  — web bridge page calls (cookie-auth)
 *   3.  POST /api/auth/desktop/exchange    — desktop calls (PKCE-proven)
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import { oauthHandoff, users } from '../../db/schema.js';
import { isEnabled } from '../../lib/feature-flags.js';
import { logger } from '../../logger.js';
import { requireAuth, type AuthVars } from '../../middleware/auth.js';
import { signUserToken } from '../jwt.js';
import { getProvider, type ProviderId } from '../oauth/providers.js';

export const desktopRoutes = new Hono<{ Variables: AuthVars }>();

// === Constants ===

const VALID_PROVIDERS: ReadonlySet<ProviderId> = new Set(['github', 'google', 'oidc']);
const HANDOFF_TTL_SECONDS = 5 * 60;
// PKCE per RFC 7636 §4.1: verifier 43-128 chars [A-Z][a-z][0-9]-._~. We send
// a fixed 32-byte random → 43-char b64url, but accept the full legal range
// for any future client.
const PKCE_CHALLENGE_LEN_MIN = 43;
const PKCE_CHALLENGE_LEN_MAX = 128;
const B64URL_RX = /^[A-Za-z0-9_-]+$/;

// === Flag gate (mirrors oauth/routes.ts shape) ===

function gate() {
  if (!isEnabled('desktopOauth')) {
    throw new HTTPException(404, {
      message: 'desktop oauth is disabled',
      cause: { code: 'NOT_FOUND' },
    });
  }
}

// === PKCE helpers ===

function sha256B64url(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64url');
}

function randomB64url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Constant-time string comparison. The handoff `code` is verified by
 * comparing SHA256 hashes; using === would leak length/timing on the
 * pre-image. timingSafeEqual requires equal lengths — pad both sides
 * with a fixed prefix to keep the call safe even on accidental misuse.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// === 1) GET /api/auth/desktop/start ===

/**
 * Desktop opens this URL in the system browser. We persist the PKCE
 * challenge keyed by a server-issued `handoff_id`, then 302 into the
 * existing /oauth/<provider>/start route — the user completes the
 * normal web OAuth flow. The cookie-auth login state is the side
 * effect we need; the redirect target carries the handoff_id forward.
 */
desktopRoutes.get('/desktop/start', async (c) => {
  gate();

  const providerId = c.req.query('provider');
  const codeChallenge = c.req.query('code_challenge');
  const method = c.req.query('code_challenge_method');

  if (!providerId || !VALID_PROVIDERS.has(providerId as ProviderId)) {
    throw new HTTPException(400, {
      message: 'unknown or missing provider',
      cause: { code: 'INVALID_PROVIDER' },
    });
  }
  // Provider must also be configured (env vars set + flagged enabled at the
  // OAuth layer). Reuses the same registry the web buttons read.
  if (!getProvider(providerId as ProviderId)) {
    throw new HTTPException(404, {
      message: `provider ${providerId} not enabled`,
      cause: { code: 'PROVIDER_NOT_ENABLED' },
    });
  }
  // RFC 7636 §4.4.2: when servers can require S256 they SHOULD reject plain.
  // We control the desktop client, so we can.
  if (method !== 'S256') {
    throw new HTTPException(400, {
      message: 'code_challenge_method must be S256',
      cause: { code: 'INVALID_PKCE_METHOD' },
    });
  }
  if (
    !codeChallenge ||
    codeChallenge.length < PKCE_CHALLENGE_LEN_MIN ||
    codeChallenge.length > PKCE_CHALLENGE_LEN_MAX ||
    !B64URL_RX.test(codeChallenge)
  ) {
    throw new HTTPException(400, {
      message: 'invalid code_challenge',
      cause: { code: 'INVALID_PKCE_CHALLENGE' },
    });
  }

  const id = randomB64url(32);
  await db.insert(oauthHandoff).values({
    id,
    provider: providerId,
    codeChallenge,
    expiresAt: new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000),
  });

  // Forward to the existing OAuth start handler. `redirect` is constrained
  // to relative paths by oauth/handler.ts safeRedirect(); /auth/desktop/handoff
  // is a same-origin path on the web side.
  const redirect = `/auth/desktop/handoff?handoff=${encodeURIComponent(id)}`;
  return c.redirect(
    `/api/auth/oauth/${providerId}/start?redirect=${encodeURIComponent(redirect)}`,
    302,
  );
});

// === 2) POST /api/auth/desktop/issue-code ===

/**
 * Called by the web `/auth/desktop/handoff` page after the OAuth callback
 * has set the auth cookie. Mints a one-time code that the desktop will
 * trade for a JWT. Cookie auth proves the user owns the session that
 * just completed OAuth.
 */
desktopRoutes.post('/desktop/issue-code', requireAuth(), async (c) => {
  gate();
  const userId = c.get('userId');

  let body: { handoff_id?: unknown };
  try {
    body = (await c.req.json()) as { handoff_id?: unknown };
  } catch {
    throw new HTTPException(400, {
      message: 'invalid JSON body',
      cause: { code: 'INVALID_BODY' },
    });
  }
  const handoffId = typeof body.handoff_id === 'string' ? body.handoff_id : '';
  if (!handoffId) {
    throw new HTTPException(400, {
      message: 'handoff_id is required',
      cause: { code: 'INVALID_HANDOFF_ID' },
    });
  }

  // Must be live (not consumed, not expired) AND fresh (no code_hash yet —
  // we don't reissue codes for the same handoff because two browser tabs
  // racing the bridge page would produce two valid codes for one challenge,
  // breaking single-use).
  const code = randomB64url(32);
  const codeHash = sha256B64url(code);
  const result = await db
    .update(oauthHandoff)
    .set({ codeHash, userId })
    .where(
      and(
        eq(oauthHandoff.id, handoffId),
        isNull(oauthHandoff.codeHash),
        isNull(oauthHandoff.consumedAt),
        gt(oauthHandoff.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: oauthHandoff.id });

  if (result.length === 0) {
    // Could be: unknown id, already issued, already consumed, or expired.
    // Single status code keeps the response shape from leaking which.
    throw new HTTPException(410, {
      message: 'handoff is no longer claimable',
      cause: { code: 'HANDOFF_GONE' },
    });
  }

  logger.info({ handoffId, userId }, 'desktop oauth: code issued');
  return c.json({ code });
});

// === 3) POST /api/auth/desktop/exchange ===

/**
 * Desktop calls this with the deep-link payload + the verifier it has
 * been holding in memory since /start. The atomic UPDATE-then-RETURNING
 * is what makes the code single-use even under concurrent retries.
 */
desktopRoutes.post('/desktop/exchange', async (c) => {
  gate();

  let body: {
    handoff_id?: unknown;
    code?: unknown;
    code_verifier?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    throw new HTTPException(400, {
      message: 'invalid JSON body',
      cause: { code: 'INVALID_BODY' },
    });
  }
  const handoffId = typeof body.handoff_id === 'string' ? body.handoff_id : '';
  const code = typeof body.code === 'string' ? body.code : '';
  const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
  if (!handoffId || !code || !verifier) {
    throw new HTTPException(400, {
      message: 'handoff_id, code, code_verifier are required',
      cause: { code: 'INVALID_BODY' },
    });
  }
  if (
    verifier.length < PKCE_CHALLENGE_LEN_MIN ||
    verifier.length > PKCE_CHALLENGE_LEN_MAX ||
    !B64URL_RX.test(verifier)
  ) {
    throw new HTTPException(400, {
      message: 'invalid code_verifier',
      cause: { code: 'INVALID_PKCE_VERIFIER' },
    });
  }

  // Atomic single-use consumption. Match by id + code_hash + freshness in
  // one statement so two concurrent /exchange calls can't both win.
  const codeHash = sha256B64url(code);
  const consumed = await db
    .update(oauthHandoff)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(oauthHandoff.id, handoffId),
        eq(oauthHandoff.codeHash, codeHash),
        isNull(oauthHandoff.consumedAt),
        gt(oauthHandoff.expiresAt, sql`now()`),
      ),
    )
    .returning({
      userId: oauthHandoff.userId,
      codeChallenge: oauthHandoff.codeChallenge,
    });

  if (consumed.length === 0) {
    throw new HTTPException(400, {
      message: 'invalid or already-consumed handoff',
      cause: { code: 'HANDOFF_INVALID' },
    });
  }
  const row = consumed[0]!;

  // PKCE check happens AFTER the row is locked-as-consumed — that way a
  // bad-verifier guess still burns the code (no oracle for "is the code
  // right but the verifier wrong?"). Hashes are constant-length so the
  // safeEqual comparison is genuinely constant-time.
  const expectedChallenge = sha256B64url(verifier);
  if (!safeEqual(expectedChallenge, row.codeChallenge)) {
    throw new HTTPException(400, {
      message: 'pkce verifier does not match challenge',
      cause: { code: 'PKCE_MISMATCH' },
    });
  }
  if (!row.userId) {
    // Defensive — issue-code always sets user_id atomically with code_hash,
    // so this branch is unreachable unless the schema invariant is violated.
    throw new HTTPException(500, {
      message: 'handoff missing user',
      cause: { code: 'HANDOFF_NO_USER' },
    });
  }

  // Fetch user + email for the return payload — same shape as /api/auth/me
  // would return, so the desktop client can hydrate UI without a follow-up
  // round-trip.
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!user) {
    throw new HTTPException(500, {
      message: 'handoff user no longer exists',
      cause: { code: 'HANDOFF_USER_MISSING' },
    });
  }

  const token = await signUserToken(user.id);
  logger.info({ handoffId, userId: user.id }, 'desktop oauth: exchanged');
  return c.json({ token, user });
});
