import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';
import { setAuthCookie } from './cookie.js';
import { signUserToken } from './jwt.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
  refreshTokenPrefix,
  verifyRefreshToken,
} from './refresh-token.js';

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

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
  zValidator('json', refreshSchema, (result) => {
    if (!result.success) {
      throw new HTTPException(400, {
        message: 'Invalid refresh input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(result.error) },
      });
    }
  }),
  async (c) => {
    const { refreshToken: raw } = c.req.valid('json');
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
    return c.json({ token, refreshToken: outcome.refreshToken });
  },
);
