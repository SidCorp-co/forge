import argon2 from 'argon2';
import { and, eq, type InferSelectModel, isNull, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db, type Tx } from '../db/client.js';
import { personalAccessTokens, type UserKind, users } from '../db/schema.js';
import {
  generatePatPlaintext,
  isPatValid,
  PAT_PREFIX_LEN,
  patEnvForNodeEnv,
  patPrefixOf,
} from './pat-format.js';
import { patIsLive } from './pat-live.js';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export type Pat = InferSelectModel<typeof personalAccessTokens>;

export { patIsLive } from './pat-live.js';

export interface MintPatInput {
  userId: string;
  name: string;
  scopes?: string[] | undefined;
  projectIds?: string[] | null | undefined;
  boundProjectId?: string | null | undefined;
  /**
   * The permission names granted, or omitted for every group. See
   * `auth/pat-permissions.ts`.
   */
  permissions?: readonly string[] | null | undefined;
  /** The paired box this token is issued to — see `devices/credential.ts`. */
  deviceId?: string | null | undefined;
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

let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash(`__pat_dummy__${env.PAT_PEPPER}__${Date.now()}`, ARGON2_OPTIONS);
  }
  return dummyHashPromise;
}

/**
 * Mint a token. `tx` exists so a caller that must decide the token's FENCE and
 * insert it atomically can do both on one connection (ISS-1093); it defaults to
 * the ambient handle, so every other caller is unchanged.
 */
export async function mintPat(input: MintPatInput, tx: Tx = db): Promise<MintedPat> {
  const plaintext = generatePatPlaintext(patEnvForNodeEnv(env.NODE_ENV));
  const tokenPrefix = plaintext.slice(0, PAT_PREFIX_LEN);
  const tokenHash = await hashPatPlaintext(plaintext);

  const [row] = await tx
    .insert(personalAccessTokens)
    .values({
      userId: input.userId,
      name: input.name,
      tokenHash,
      tokenPrefix,
      scopes: input.scopes ?? ['read', 'write'],
      projectIds: input.projectIds ?? null,
      boundProjectId: input.boundProjectId ?? null,
      permissions: input.permissions ? [...input.permissions] : null,
      deviceId: input.deviceId ?? null,
      expiresAt: input.expiresAt ?? null,
      rateLimitMax: input.rateLimitMax ?? null,
    })
    .returning();

  if (!row) throw new Error('mintPat: insert returned no row');
  return { row, plaintext };
}

/**
 * Order the writers that both mean to own the one live token called `name`.
 * The key is the name ALONE, wider than `pat_user_name_uniq`'s `(user_id,
 * name)`: the device credential writers take that name from another HOLDER as
 * well as their own, so a user-scoped key would order them against nothing.
 */
export async function lockPatName(tx: Tx, name: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
}

export interface VerifiedPat {
  row: Pat;
  /**
   * The kind of the principal the token belongs to. Read here so the one place
   * a PAT principal is built can answer `agency` from WHO holds the token.
   */
  ownerKind: UserKind;
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
    .select({ pat: personalAccessTokens, ownerKind: users.kind })
    .from(personalAccessTokens)
    .innerJoin(users, eq(users.id, personalAccessTokens.userId))
    .where(and(eq(personalAccessTokens.tokenPrefix, prefix), patIsLive()));

  if (rows.length === 0) {
    try {
      await argon2.verify(await getDummyHash(), plaintext + env.PAT_PEPPER);
    } catch {}
    return null;
  }

  let matched: VerifiedPat | null = null;
  for (const row of rows) {
    let ok = false;
    try {
      ok = await argon2.verify(row.pat.tokenHash, plaintext + env.PAT_PEPPER);
    } catch {
      ok = false;
    }
    if (ok && matched === null) matched = { row: row.pat, ownerKind: row.ownerKind };
  }

  return matched;
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
 * Bulk revoke every live PAT for a user. Called from password-change /
 * account-disable hooks (T1, T4 mitigations in the threat model). `reason` is
 * logged, never persisted.
 */
export async function revokeAllPatsForUser(
  userId: string,
  reason: 'password_changed' | 'user_disabled' | 'admin_revoke',
): Promise<number> {
  const result = await db
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)))
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
 * Replace a token with a fresh one of the same name. The row is read INSIDE the
 * transaction and the revoke scoped to what is live under `(user_id, name)`, not
 * to the id read: a read taken outside is the race (ISS-1184), and under
 * {@link lockPatName} the second of two rotations supersedes the first's insert.
 */
export async function rotatePat(input: RotatePatInput): Promise<MintedPat | null> {
  const plaintext = generatePatPlaintext(patEnvForNodeEnv(env.NODE_ENV));
  const tokenPrefix = plaintext.slice(0, PAT_PREFIX_LEN);
  const tokenHash = await hashPatPlaintext(plaintext);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(personalAccessTokens)
      .where(
        and(eq(personalAccessTokens.id, input.id), eq(personalAccessTokens.userId, input.userId)),
      )
      .limit(1);
    if (!existing) return null;

    await lockPatName(tx, existing.name);
    await tx
      .update(personalAccessTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(personalAccessTokens.userId, existing.userId),
          eq(personalAccessTokens.name, existing.name),
          isNull(personalAccessTokens.revokedAt),
        ),
      );

    const [row] = await tx
      .insert(personalAccessTokens)
      .values({
        userId: existing.userId,
        name: existing.name,
        tokenHash,
        tokenPrefix,
        scopes: existing.scopes,
        projectIds: existing.projectIds,
        permissions: existing.permissions,
        boundProjectId: existing.boundProjectId,
        deviceId: existing.deviceId,
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
        isNull(personalAccessTokens.deviceId),
      ),
    );
  return rows.length;
}
