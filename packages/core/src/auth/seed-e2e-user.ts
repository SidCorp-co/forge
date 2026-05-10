/**
 * Optional startup seed for an end-to-end test bot user.
 *
 * When `E2E_USER_EMAIL` + `E2E_USER_PASSWORD` are both set in env, this
 * function ensures a verified user with that email exists, hashing the
 * password with the same argon2id parameters as the local-auth flow.
 *
 * Idempotent:
 * - Row missing → INSERT with `emailVerifiedAt = NOW()`.
 * - Row exists with NULL or different hash → UPDATE the hash and (re-)set
 *   `emailVerifiedAt` if it was unset.
 * - Row exists with a hash that already verifies the env password → no-op.
 *
 * Skips silently when env is unset so fresh installations are unaffected.
 *
 * Why bootstrap and not a SQL migration: a SQL migration would either bake
 * a hardcoded hash into git (every fork would inherit a known credential)
 * or stage an empty user that login then rejects. Reading from env at
 * startup keeps the credential out of git, makes per-environment override
 * trivial, and lets operators rotate by changing env + restarting the core.
 *
 * Project membership is intentionally NOT seeded here — operators add the
 * bot to whatever projects e2e suites need to exercise via the normal
 * `project_members` flow.
 */

import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { env } from '../config/env.js';
import { hashPassword } from './password.js';
import { logger } from '../logger.js';

export async function seedE2eUserIfConfigured(
  db: typeof defaultDb = defaultDb,
): Promise<{ skipped: true } | { action: 'inserted' | 'refreshed' | 'noop'; userId: string }> {
  const email = env.E2E_USER_EMAIL;
  const password = env.E2E_USER_PASSWORD;
  if (!email || !password) return { skipped: true };

  const [existing] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!existing) {
    const passwordHash = await hashPassword(password);
    const [inserted] = await db
      .insert(users)
      .values({ email, passwordHash, emailVerifiedAt: new Date() })
      .returning({ id: users.id });
    if (!inserted) throw new Error('seed-e2e-user: insert returned no row');
    logger.info({ email, userId: inserted.id }, 'seeded e2e test user');
    return { action: 'inserted', userId: inserted.id };
  }

  // Skip the re-hash when the existing hash already verifies the env
  // password — saves an unnecessary write and keeps the row stable across
  // boots. Falls through to refresh on null/legacy hashes too.
  if (existing.passwordHash) {
    try {
      if (await argon2.verify(existing.passwordHash, password)) {
        if (!existing.emailVerifiedAt) {
          await db
            .update(users)
            .set({ emailVerifiedAt: new Date() })
            .where(eq(users.id, existing.id));
          logger.info({ email, userId: existing.id }, 'verified existing e2e test user');
          return { action: 'refreshed', userId: existing.id };
        }
        return { action: 'noop', userId: existing.id };
      }
    } catch {
      // malformed hash → fall through to overwrite
    }
  }

  const passwordHash = await hashPassword(password);
  await db
    .update(users)
    .set({
      passwordHash,
      emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
    })
    .where(eq(users.id, existing.id));
  logger.info({ email, userId: existing.id }, 'refreshed e2e test user password');
  return { action: 'refreshed', userId: existing.id };
}
