import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { emailVerificationTokens, users } from '../db/schema.js';

export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_INSERT_RETRIES = 3;

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

export async function issueVerificationToken(userId: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    try {
      await db.insert(emailVerificationTokens).values({ token, userId, expiresAt });
      return token;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('failed to issue verification token after retries');
}

export type ConsumeResult = 'ok' | 'expired' | null;

export async function consumeVerificationToken(token: string): Promise<ConsumeResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ user_id: string; expires_at: Date }>(
      sql`select user_id, expires_at from ${emailVerificationTokens}
          where token = ${token} for update`,
    );
    const row = rows[0];
    if (!row) return null;

    if (new Date(row.expires_at).getTime() < Date.now()) {
      await tx.delete(emailVerificationTokens).where(eq(emailVerificationTokens.token, token));
      return 'expired';
    }

    await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, row.user_id));
    await tx.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, row.user_id));

    return 'ok';
  });
}
