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

async function invalidateAllForUser(tx: Tx, userId: string): Promise<void> {
  await tx
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

    const result = await db.transaction(async (tx) => {
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
      if (!matched) throw invalid();

      if (matched.usedAt !== null) {
        await invalidateAllForUser(tx, matched.userId);
        throw reused();
      }

      if (matched.expiresAt.getTime() <= Date.now()) {
        throw expired();
      }

      const claimed = await tx
        .update(refreshTokens)
        .set({ usedAt: sql`now()` })
        .where(and(eq(refreshTokens.id, matched.id), isNull(refreshTokens.usedAt)))
        .returning({ id: refreshTokens.id });

      if (claimed.length === 0) {
        await invalidateAllForUser(tx, matched.userId);
        throw reused();
      }

      const { raw: newRaw } = await issueRefreshToken(tx, matched.userId);
      return { userId: matched.userId, refreshToken: newRaw };
    });

    const token = await signUserToken(result.userId);
    setAuthCookie(c, token);
    return c.json({ token, refreshToken: result.refreshToken });
  },
);
