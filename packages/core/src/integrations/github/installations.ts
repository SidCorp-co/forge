/**
 * The installations of the instance's GitHub App that Forge has recorded, and for which org.
 *
 * GitHub's own `/app/installations` lists every account that installed a public App, anyone's: it
 * is never read as a grant. An installation reaches an org's projects only once it is recorded for
 * that org, proven by GitHub's OAuth answer to the admin who installed it (`instance-app.ts`) or
 * carried from a binding that held it before this table existed.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  type GithubAccountType,
  type GithubAppInstallationRow,
  type GithubInstallationProof,
  type GithubInstallationState,
  githubAppInstallations,
} from '../../db/schema.js';

export type { GithubAppInstallationRow };

export type RecordOutcome =
  | { ok: true; row: GithubAppInstallationRow; created: boolean }
  | { ok: false; claimedBy: string; row: GithubAppInstallationRow };

/**
 * Record one installation for an org. One already recorded for the same org is answered as it
 * stands, made active again where it was not, since GitHub has just shown it to the installer. One
 * recorded for another org is never moved: the caller refuses by name.
 */
export async function recordInstallation(input: {
  connectionId: string;
  installationId: number;
  accountLogin: string;
  accountType: GithubAccountType;
  orgId: string;
  recordedBy: string | null;
  proof: GithubInstallationProof;
  /** Where GitHub stands on it now, where that is not live: a binding held one GitHub has since removed. */
  state?: GithubInstallationState;
  stateChangedAt?: Date;
}): Promise<RecordOutcome> {
  const [inserted] = await db
    .insert(githubAppInstallations)
    .values(input)
    .onConflictDoNothing({
      target: [githubAppInstallations.connectionId, githubAppInstallations.installationId],
    })
    .returning();
  if (inserted) return { ok: true, row: inserted, created: true };
  const held = await findInstallation(input.connectionId, input.installationId);
  if (!held)
    throw new Error(`github: installation ${input.installationId} neither inserted nor held`);
  if (held.orgId !== input.orgId) return { ok: false, claimedBy: held.orgId, row: held };
  if (held.state === 'active') return { ok: true, row: held, created: false };
  const [revived] = await db
    .update(githubAppInstallations)
    .set({ state: 'active', stateChangedAt: new Date(), updatedAt: new Date() })
    .where(eq(githubAppInstallations.id, held.id))
    .returning();
  return { ok: true, row: revived ?? held, created: false };
}

export async function findInstallation(
  connectionId: string,
  installationId: number,
): Promise<GithubAppInstallationRow | null> {
  const [row] = await db
    .select()
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.connectionId, connectionId),
        eq(githubAppInstallations.installationId, installationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every installation of this App recorded for one of these orgs, in any state. */
export async function listInstallationsForOrgs(
  connectionId: string,
  orgIds: readonly string[],
): Promise<GithubAppInstallationRow[]> {
  if (orgIds.length === 0) return [];
  return db
    .select()
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.connectionId, connectionId),
        inArray(githubAppInstallations.orgId, [...orgIds]),
      ),
    )
    .orderBy(githubAppInstallations.createdAt);
}

/** Every installation of this App, recorded for any org: the read a binding's standing is judged on. */
export async function listInstallationsOf(
  connectionId: string,
  installationIds: readonly number[],
): Promise<GithubAppInstallationRow[]> {
  if (installationIds.length === 0) return [];
  return db
    .select()
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.connectionId, connectionId),
        inArray(githubAppInstallations.installationId, [...installationIds]),
      ),
    );
}

/** GitHub's `installation` webhook moved one: null when Forge never recorded it, and nothing is written. */
export async function setInstallationState(
  connectionId: string,
  installationId: number,
  state: GithubInstallationState,
): Promise<GithubAppInstallationRow | null> {
  const at = new Date();
  const [row] = await db
    .update(githubAppInstallations)
    .set({ state, stateChangedAt: at, updatedAt: at })
    .where(
      and(
        eq(githubAppInstallations.connectionId, connectionId),
        eq(githubAppInstallations.installationId, installationId),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * GitHub's `installation_repositories` webhook: names taken off the installation are kept so their
 * bindings read why, and a name given back is dropped from them. Null when Forge never recorded it.
 */
export async function noteInstallationRepositories(
  connectionId: string,
  installationId: number,
  change: { added: readonly string[]; removed: readonly string[] },
): Promise<GithubAppInstallationRow | null> {
  const held = await findInstallation(connectionId, installationId);
  if (!held) return null;
  const lower = (names: readonly string[]) => new Set(names.map((n) => n.toLowerCase()));
  const added = lower(change.added);
  const kept = held.removedRepositories.filter((n) => !added.has(n.toLowerCase()));
  const keptLower = lower(kept);
  const removed = [...kept, ...change.removed.filter((n) => !keptLower.has(n.toLowerCase()))];
  const [row] = await db
    .update(githubAppInstallations)
    .set({ removedRepositories: sql`${JSON.stringify(removed)}::jsonb`, updatedAt: new Date() })
    .where(eq(githubAppInstallations.id, held.id))
    .returning();
  return row ?? null;
}
