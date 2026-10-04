import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
  verifyRefreshToken,
} from '../credentials/refresh-token.js';
import { db, type Tx } from '../db/client.js';
import { refreshTokens, users } from '../db/schema.js';
import { ensurePersonalOrg } from '../orgs/index.js';

/** A new refresh token for `userId`, written inside the caller's transaction; answers the raw value. */
async function issueRefreshToken(tx: Tx, userId: string): Promise<{ raw: string }> {
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

/** A refresh token for `userId` in its own transaction. */
export async function openRefreshToken(userId: string): Promise<{ raw: string }> {
  return db.transaction((tx) => issueRefreshToken(tx, userId));
}

/**
 * Every unused refresh token of `userId` marked used, as its own auto-committed statement so it
 * persists independently of any rotation transaction.
 */
export async function invalidateRefreshTokens(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ usedAt: sql`now()` })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.usedAt)));
}

export type RefreshOutcome =
  | { kind: 'ok'; userId: string; refreshToken: string }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'replay'; userId: string };

/** Claims the refresh token matching `raw` under `prefix` and issues its successor. */
export async function rotateRefreshToken(raw: string, prefix: string): Promise<RefreshOutcome> {
  return db.transaction(async (tx): Promise<RefreshOutcome> => {
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
}

/**
 * A local user and their personal org, created as one unit — a half-provisioned user would 500
 * every project create later. A taken address surfaces as the unique violation.
 */
export async function registerUser(
  email: string,
  passwordHash: string,
): Promise<{ userId: string; email: string }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({ email, passwordHash })
      .returning({ userId: users.id, email: users.email });
    const created = inserted[0];
    if (!created) {
      throw new Error('register: insert returned no row');
    }
    await ensurePersonalOrg(tx, created.userId, created.email);
    return created;
  });
}

/** Stamps the moment a user last proved their password. */
export async function markFreshAuth(userId: string, at: Date): Promise<void> {
  await db.update(users).set({ lastFreshAuthAt: at }).where(eq(users.id, userId));
}

/** The signed-in user's own display name set; undefined when the account is gone. */
export async function setOwnDisplayName(userId: string, displayName: string | null) {
  const [row] = await db
    .update(users)
    .set({ displayName })
    .where(eq(users.id, userId))
    .returning({ id: users.id, email: users.email, displayName: users.displayName });
  return row;
}
