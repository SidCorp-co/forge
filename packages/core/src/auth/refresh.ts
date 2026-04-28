import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';
import { REFRESH_COOKIE_NAME, setAuthCookie, setRefreshCookie } from './cookie.js';
import { signUserToken } from './jwt.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
  refreshTokenPrefix,
  verifyRefreshToken,
} from './refresh-token.js';

export const refreshRoutes = new Hono();

const invalid = () =>
  new HTTPException(401, {
    message: 'invalid refresh token',
    cause: { code: 'INVALID_REFRESH_TOKEN' },
  });

const expired = () =>
  new HTTPException(401, {
    message: 'refresh token expired',
    cause: { code: 'REFRESH_TOKEN_EXPIRED' },
  });

const reused = () =>
  new HTTPException(401, {
    message: 'refresh token reuse detected',
    cause: { code: 'REFRESH_TOKEN_REUSED' },
  });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type InvalidateRunner = Pick<Tx, 'update'>;

async function invalidateAllForUser(runner: InvalidateRunner, userId: string): Promise<void> {
  await runner
    .update(refreshTokens)
    .set({ usedAt: sql`now()` })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.usedAt)));
}

export async function issueRefreshToken(tx: Tx, userId: string): Promise<{ raw: string }> {
  const { raw, prefix } = generateRefreshToken();
  const tokenHash = await hashRefreshToken(raw);
  await tx.insert(refreshTokens).values({
    userId,
    tokenPrefix: prefix,
    tokenHash,
    expiresAt: refreshTokenExpiresAt(),
  });
  return { raw };
}

type RefreshOutcome =
  | { kind: 'ok'; userId: string; refreshToken: string }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'replay'; userId: string };

refreshRoutes.post(
  '/refresh',
  async (c) => {
    // Refresh token lives ONLY in the httpOnly cookie at this point — the
    // body fallback was removed in ISS-315 cleanup once every client had
    // landed on the cookie path. A missing cookie returns the same
    // INVALID_REFRESH_TOKEN that a forged token would, so a probe can't
    // distinguish "no cookie" from "wrong cookie".
    const raw = getCookie(c, REFRESH_COOKIE_NAME);
    if (!raw) throw invalid();
    const prefix = refreshTokenPrefix(raw);

    // The rotation transaction only mutates the matched row + inserts the new
    // row. Replay/race detection returns a sentinel so the mass-invalidate can
    // happen AFTER this transaction commits — otherwise throwing inside the
    // transaction rolls the invalidation back and the replay defense silently
    // does nothing.
    const outcome: RefreshOutcome = await db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenPrefix, prefix))
        .for('update');

      let matched: (typeof candidates)[number] | null = null;
      for (const row of candidates) {
        if (await verifyRefreshToken(row.tokenHash, raw)) {
          matched = row;
          break;
        }
      }
      if (!matched) return { kind: 'invalid' };

      if (matched.usedAt !== null) {
        return { kind: 'replay', userId: matched.userId };
      }

      if (matched.expiresAt.getTime() <= Date.now()) {
        return { kind: 'expired' };
      }

      const claimed = await tx
        .update(refreshTokens)
        .set({ usedAt: sql`now()` })
        .where(and(eq(refreshTokens.id, matched.id), isNull(refreshTokens.usedAt)))
        .returning({ id: refreshTokens.id });

      if (claimed.length === 0) {
        return { kind: 'replay', userId: matched.userId };
      }

      const { raw: newRaw } = await issueRefreshToken(tx, matched.userId);
      return { kind: 'ok', userId: matched.userId, refreshToken: newRaw };
    });

    if (outcome.kind === 'invalid') throw invalid();
    if (outcome.kind === 'expired') throw expired();
    if (outcome.kind === 'replay') {
      // Runs as its own auto-committed statement on the pool so the
      // invalidation persists independently of the rotation transaction.
      await invalidateAllForUser(db, outcome.userId);
      throw reused();
    }

    const token = await signUserToken(outcome.userId);
    setAuthCookie(c, token);
    setRefreshCookie(c, outcome.refreshToken);
    // refreshToken stays out of the JSON body (cookie-only since ISS-315
    // cleanup) — clients should rely on the cookie roundtrip.
    return c.json({ token });
  },
);
