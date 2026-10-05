import argon2 from 'argon2';
import { and, desc, eq, type InferSelectModel, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { personalAccessTokens, type UserKind, users } from '../db/schema.js';
import { lockXact } from '../lib/advisory-lock.js';
import { env } from '../lib/env.js';
import {
  generatePatPlaintext,
  isPatValid,
  PAT_PREFIX_LEN,
  patEnvForNodeEnv,
  patPrefixOf,
} from './pat-format.js';
import { patIsLive } from './pat-live.js';
import { PAT_EXPLICIT_PERMISSIONS, PAT_PERMISSION_ALL } from './pat-permissions.js';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

type Pat = InferSelectModel<typeof personalAccessTokens>;

export { patIsLive } from './pat-live.js';

interface MintPatInput {
  userId: string;
  name: string;
  scopes?: string[] | undefined;
  projectIds?: string[] | null | undefined;
  boundProjectId?: string | null | undefined;
  /**
   * What this token may reach: the names, or `PAT_GRANT_ALL` for the whole
   * menu. Omitting it writes the legacy shape, which reaches everything.
   */
  permissions?: readonly string[] | null | undefined;
  /** The menu epoch this token's reach is fixed at; omitted, it is 1, the narrowest. */
  grantEpoch?: number | undefined;
  /** The paired box this token is issued to — see `devices/credential.ts`. */
  deviceId?: string | null | undefined;
  expiresAt?: Date | null | undefined;
  rateLimitMax?: number | null | undefined;
  /** The person this token acts for when it is not its holder's own — see `personalAccessTokens.onBehalfOf`. */
  onBehalfOf?: string | null | undefined;
}

interface MintedPat {
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
      grantEpoch: input.grantEpoch ?? 1,
      deviceId: input.deviceId ?? null,
      expiresAt: input.expiresAt ?? null,
      rateLimitMax: input.rateLimitMax ?? null,
      onBehalfOf: input.onBehalfOf ?? null,
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
  await lockXact(tx, 'patName', name);
}

/** Who a live token is revoked for: its holder, the box it was issued to, or its name. */
type TokenHolder =
  | { userId: string }
  | { deviceId: string }
  | { deviceIds: readonly string[] }
  | { name: string };

/** Revoke every live token of one holder; answers how many. */
export async function revokeLiveTokens(holder: TokenHolder, tx: Tx = db): Promise<number> {
  if ('deviceIds' in holder && holder.deviceIds.length === 0) return 0;
  const of =
    'userId' in holder
      ? eq(personalAccessTokens.userId, holder.userId)
      : 'deviceId' in holder
        ? eq(personalAccessTokens.deviceId, holder.deviceId)
        : 'deviceIds' in holder
          ? inArray(personalAccessTokens.deviceId, [...holder.deviceIds])
          : eq(personalAccessTokens.name, holder.name);
  const rows = await tx
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(of, isNull(personalAccessTokens.revokedAt)))
    .returning({ id: personalAccessTokens.id });
  return rows.length;
}

/**
 * The live token called `name` that a box or its holder carries is superseded, under the name's
 * lock the caller took, before its successor is minted.
 */
export async function supersedeNamedToken(
  tx: Tx,
  name: string,
  holder: { deviceId: string; userId: string },
): Promise<void> {
  await tx
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(personalAccessTokens.name, name),
        isNull(personalAccessTokens.revokedAt),
        or(
          eq(personalAccessTokens.deviceId, holder.deviceId),
          eq(personalAccessTokens.userId, holder.userId),
        ),
      ),
    );
}
/**
 * A grant with its token-explicit names replaced by `explicit`, its route grant kept; a grant that
 * named no route group (a legacy token) keeps its whole reach as `*`.
 */
export function grantNaming(
  permissions: readonly string[] | null,
  explicit: readonly string[],
): string[] {
  const routes = (permissions ?? []).filter(
    (p) => !(PAT_EXPLICIT_PERMISSIONS as readonly string[]).includes(p),
  );
  return [...new Set([...(routes.length > 0 ? routes : [PAT_PERMISSION_ALL]), ...explicit])];
}

/** Every live token of one holder names exactly `explicit` among its token-explicit permissions; answers how many. */
export async function regrantLiveTokens(
  tx: Tx,
  userId: string,
  explicit: readonly string[],
): Promise<number> {
  const live = await tx
    .select({ id: personalAccessTokens.id, permissions: personalAccessTokens.permissions })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.userId, userId), patIsLive()));
  for (const token of live) {
    await tx
      .update(personalAccessTokens)
      .set({ permissions: grantNaming(token.permissions, explicit) })
      .where(eq(personalAccessTokens.id, token.id));
  }
  return live.length;
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

/** Every personal access token a user holds, revoked ones included, newest first. */
export async function listPatsOf(userId: string) {
  return db
    .select()
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, userId))
    .orderBy(desc(personalAccessTokens.createdAt));
}

/** Whether the user holds a live token with this name. */
export async function hasLivePatNamed(userId: string, name: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.userId, userId),
        eq(personalAccessTokens.name, name),
        isNull(personalAccessTokens.revokedAt),
      ),
    )
    .limit(1);
  return existing !== undefined;
}

/** When the user last proved who they are; null when they never have. */
export async function lastFreshAuthAt(userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: users.lastFreshAuthAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.at ?? null;
}
