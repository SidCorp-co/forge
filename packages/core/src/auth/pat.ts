/**
 * Personal Access Tokens — mint, verify, revoke, rotate (ISS-150).
 *
 * Mirrors the device-token primitives in `deviceToken.ts` but adds:
 *  - per-token argon2id pepper distinct from `DEVICE_TOKEN_PEPPER`
 *  - constant-time prefix verification: we iterate all candidate rows
 *    even after a hit so timing does not leak which row matched
 *  - asynchronous `last_used_at`/`last_used_ip` updates so the request
 *    path is never blocked on a write
 *  - explicit user-scoped revoke + bulk revoke (used by password-change
 *    and account-disable hooks).
 */

import argon2 from 'argon2';
import { type InferSelectModel, and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import {
  PAT_PREFIX_LEN,
  generatePatPlaintext,
  isPatValid,
  patEnvForNodeEnv,
  patPrefixOf,
} from './pat-format.js';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export type Pat = InferSelectModel<typeof personalAccessTokens>;

export interface MintPatInput {
  userId: string;
  name: string;
  scopes?: string[] | undefined;
  projectIds?: string[] | null | undefined;
  expiresAt?: Date | null | undefined;
  rateLimitMax?: number | null | undefined;
}

export interface MintedPat {
  row: Pat;
  plaintext: string;
}

/** Hash a plaintext PAT with the configured pepper. */
async function hashPatPlaintext(plaintext: string): Promise<string> {
  return argon2.hash(plaintext + env.PAT_PEPPER, ARGON2_OPTIONS);
}

/**
 * Lazy-computed dummy argon2 hash used to keep `verifyPat` constant-time
 * when the prefix bucket is empty. Without this, a timing attacker who can
 * speak the auth endpoint could distinguish "prefix has no live PAT" from
 * "prefix has live PAT(s) but body is wrong" via the absence of any
 * argon2.verify call. The hash itself is over a random secret that is
 * never returned to the caller.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash(
      `__pat_dummy__${env.PAT_PEPPER}__${Date.now()}`,
      ARGON2_OPTIONS,
    );
  }
  return dummyHashPromise;
}

export async function mintPat(input: MintPatInput): Promise<MintedPat> {
  const plaintext = generatePatPlaintext(patEnvForNodeEnv(env.NODE_ENV));
  const tokenPrefix = plaintext.slice(0, PAT_PREFIX_LEN);
  const tokenHash = await hashPatPlaintext(plaintext);

  const [row] = await db
    .insert(personalAccessTokens)
    .values({
      userId: input.userId,
      name: input.name,
      tokenHash,
      tokenPrefix,
      scopes: input.scopes ?? ['read', 'write'],
      projectIds: input.projectIds ?? null,
      expiresAt: input.expiresAt ?? null,
      rateLimitMax: input.rateLimitMax ?? null,
    })
    .returning();

  if (!row) throw new Error('mintPat: insert returned no row');
  return { row, plaintext };
}

export interface VerifiedPat {
  row: Pat;
}

/**
 * Verify a plaintext PAT.
 *
 * Returns the matching row when verification succeeds, otherwise null.
 * Iterates ALL candidate rows even after the first match so the verification
 * latency does not depend on the position of the matching row.
 */
export async function verifyPat(plaintext: unknown): Promise<VerifiedPat | null> {
  if (typeof plaintext !== 'string') return null;
  if (!isPatValid(plaintext)) return null;

  const prefix = patPrefixOf(plaintext);
  const rows = await db
    .select()
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.tokenPrefix, prefix),
        isNull(personalAccessTokens.revokedAt),
        or(
          isNull(personalAccessTokens.expiresAt),
          gt(personalAccessTokens.expiresAt, sql`now()`),
        ),
      ),
    );

  if (rows.length === 0) {
    // Constant-time guard: run a dummy argon2.verify so an empty bucket
    // costs the same as a populated-but-mismatched bucket. The dummy hash
    // is a one-time computation; argon2.verify uses the parameters embedded
    // in the hash so this stays aligned with ARGON2_OPTIONS.
    try {
      await argon2.verify(await getDummyHash(), plaintext + env.PAT_PEPPER);
    } catch {
      // ignore — only here for timing parity
    }
    return null;
  }

  let matched: Pat | null = null;
  for (const row of rows) {
    let ok = false;
    try {
      ok = await argon2.verify(row.tokenHash, plaintext + env.PAT_PEPPER);
    } catch {
      ok = false;
    }
    // Intentionally do NOT short-circuit: keep verifying so the work done
    // for a non-matching token is the same as a matching one.
    if (ok && matched === null) matched = row;
  }

  return matched ? { row: matched } : null;
}

/**
 * Fire-and-forget update of last_used_at / last_used_ip. Errors are
 * swallowed (logged) — never block the request path on this write.
 */
export function touchPatUsage(tokenId: string, ip: string | undefined): void {
  void (async () => {
    try {
      await db
        .update(personalAccessTokens)
        .set({ lastUsedAt: sql`now()`, lastUsedIp: ip ?? null })
        .where(eq(personalAccessTokens.id, tokenId));
    } catch (err) {
      console.warn('[pat] touchPatUsage failed', err);
    }
  })();
}

/**
 * Revoke a single PAT belonging to a user. Idempotent — already-revoked
 * PATs return the current row. Returns `null` if no row matched the
 * (id, userId) pair (caller should surface 404 to avoid existence leak).
 */
export async function revokePat(id: string, userId: string): Promise<Pat | null> {
  const [existing] = await db
    .select()
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.id, id), eq(personalAccessTokens.userId, userId)))
    .limit(1);
  if (!existing) return null;
  if (existing.revokedAt) return existing;
  const [updated] = await db
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(eq(personalAccessTokens.id, id))
    .returning();
  return updated ?? existing;
}

/**
 * Revoke a PAT without owner check — used by middleware auto-revoke paths
 * (rate-limit breach, suspicious IP). Idempotent.
 */
export async function forceRevokePat(id: string): Promise<void> {
  await db
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(personalAccessTokens.id, id), isNull(personalAccessTokens.revokedAt)));
}

/**
 * Bulk revoke every live PAT for a user. Called from password-change /
 * account-disable hooks (T1, T4 mitigations in the threat model).
 *
 * `reason` is logged but not persisted in this PR — when the audit-log
 * partitioning lands the reason will land alongside.
 */
export async function revokeAllPatsForUser(
  userId: string,
  reason: 'password_changed' | 'user_disabled' | 'admin_revoke',
): Promise<number> {
  const result = await db
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(personalAccessTokens.userId, userId),
        isNull(personalAccessTokens.revokedAt),
      ),
    )
    .returning({ id: personalAccessTokens.id });
  if (result.length > 0) {
    console.info(`[pat] revoked ${result.length} PAT(s) for user ${userId} reason=${reason}`);
  }
  return result.length;
}

export interface RotatePatInput {
  id: string;
  userId: string;
  expiresAt?: Date | null;
}

/**
 * Rotate a PAT — mint a fresh plaintext, revoke the old row immediately.
 * Returns null if the (id, userId) pair does not match. The new row
 * carries over `name`/`scopes`/`projectIds`/`rateLimitMax` from the old.
 *
 * The rename/revoke + insert run in a single transaction so a failed mint
 * cannot leave the user with a revoked old PAT and no replacement.
 */
export async function rotatePat(input: RotatePatInput): Promise<MintedPat | null> {
  const [existing] = await db
    .select()
    .from(personalAccessTokens)
    .where(
      and(eq(personalAccessTokens.id, input.id), eq(personalAccessTokens.userId, input.userId)),
    )
    .limit(1);
  if (!existing) return null;

  // Hash outside the tx — argon2id is slow and we don't want to hold a
  // row-level lock for ~100ms.
  const plaintext = generatePatPlaintext(patEnvForNodeEnv(env.NODE_ENV));
  const tokenPrefix = plaintext.slice(0, PAT_PREFIX_LEN);
  const tokenHash = await hashPatPlaintext(plaintext);
  const stamp = Date.now();

  return db.transaction(async (tx) => {
    await tx
      .update(personalAccessTokens)
      .set({ name: `${existing.name}.rotated.${stamp}`, revokedAt: sql`now()` })
      .where(eq(personalAccessTokens.id, existing.id));

    const [row] = await tx
      .insert(personalAccessTokens)
      .values({
        userId: existing.userId,
        name: existing.name,
        tokenHash,
        tokenPrefix,
        scopes: existing.scopes,
        projectIds: existing.projectIds,
        expiresAt: input.expiresAt ?? existing.expiresAt,
        rateLimitMax: existing.rateLimitMax,
      })
      .returning();

    if (!row) throw new Error('rotatePat: insert returned no row');
    return { row, plaintext };
  });
}

/** Count active PATs for a user. Used for the per-user cap. */
export async function countActivePatsForUser(userId: string): Promise<number> {
  const rows = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.userId, userId),
        isNull(personalAccessTokens.revokedAt),
      ),
    );
  return rows.length;
}
