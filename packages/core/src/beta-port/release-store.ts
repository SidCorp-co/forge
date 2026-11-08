// What the beta port keeps of the releases pressed on beta (ISS-988): one row per beta release it
// took, the latest start of a beta project's rows as its high-water mark there, and the dev release
// each was run as. Nothing beta answers is stored here but the row's own bookkeeping.

import { and, eq, isNull, max, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type BetaPortReleaseState,
  type BetaReleaseIssue,
  betaPortReleases,
} from '../db/schema.js';
import { releaseRunsByIds } from '../pipeline/index.js';

/** A beta release the port took, as a fire reads it back. */
export interface TakenRelease {
  id: string;
  betaRunId: string;
  betaProjectId: string;
  betaVersion: string | null;
  betaIssues: BetaReleaseIssue[];
  devProjectId: string;
  devIssueIds: string[];
  noTwin: string[];
  state: BetaPortReleaseState;
  said: string | null;
  devRunId: string | null;
  devVersion: string | null;
  betaEnded: string | null;
  told: string[];
}

/** The latest start of a beta release this port took on a beta project: its high-water mark. */
export async function releaseMarkOf(betaProjectSlug: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: max(betaPortReleases.betaStartedAt) })
    .from(betaPortReleases)
    .where(eq(betaPortReleases.betaProjectSlug, betaProjectSlug));
  return row?.at ?? null;
}

/** Take a beta release once: whether this call took it, false where an earlier fire had. */
export async function takeRelease(row: {
  betaRunId: string;
  betaProjectId: string;
  betaProjectSlug: string;
  betaVersion: string | null;
  betaStartedAt: Date;
  betaIssues: BetaReleaseIssue[];
  devProjectId: string;
  devIssueIds: string[];
  noTwin: string[];
  state: BetaPortReleaseState;
}): Promise<boolean> {
  const taken = await db
    .insert(betaPortReleases)
    .values(row)
    .onConflictDoNothing({ target: betaPortReleases.betaRunId })
    .returning({ id: betaPortReleases.id });
  return taken.length > 0;
}

/** The releases taken on one beta project whose outcome is not yet written back on beta, oldest first. */
export async function openReleasesOf(betaProjectSlug: string): Promise<TakenRelease[]> {
  return db
    .select({
      id: betaPortReleases.id,
      betaRunId: betaPortReleases.betaRunId,
      betaProjectId: betaPortReleases.betaProjectId,
      betaVersion: betaPortReleases.betaVersion,
      betaIssues: betaPortReleases.betaIssues,
      devProjectId: betaPortReleases.devProjectId,
      devIssueIds: betaPortReleases.devIssueIds,
      noTwin: betaPortReleases.noTwin,
      state: betaPortReleases.state,
      said: betaPortReleases.said,
      devRunId: betaPortReleases.devRunId,
      devVersion: betaPortReleases.devVersion,
      betaEnded: betaPortReleases.betaEnded,
      told: betaPortReleases.told,
    })
    .from(betaPortReleases)
    .where(
      and(
        eq(betaPortReleases.betaProjectSlug, betaProjectSlug),
        isNull(betaPortReleases.writtenBackAt),
        sql`${betaPortReleases.state} <> 'no_twin'`,
      ),
    )
    .orderBy(betaPortReleases.betaStartedAt);
}

/** Write what a fire learned of a taken release. */
export async function updateRelease(
  id: string,
  set: Partial<{
    state: BetaPortReleaseState;
    said: string | null;
    devRunId: string;
    devVersion: string | null;
    betaEnded: string;
    told: string[];
    writtenBackAt: Date;
  }>,
): Promise<void> {
  await db
    .update(betaPortReleases)
    .set({ ...set, at: new Date() })
    .where(eq(betaPortReleases.id, id));
}

/** Where a dev release stands: still open, shipped, or ended without shipping; null where unread. */
export interface DevReleaseStanding {
  version: string;
  outcome: 'open' | 'shipped' | 'failed';
}

/**
 * The dev release run `runId` of `projectId` and its outcome, read as every release reader reads one
 * (`release-batch/versions.ts:versionStatus`): a ship stamp is shipped, an open run is still at work,
 * and a run that ended without one failed or was aborted, which the port reports as failed.
 */
export async function devReleaseStanding(
  projectId: string,
  runId: string,
): Promise<DevReleaseStanding | null> {
  const [run] = await releaseRunsByIds(projectId, [runId]);
  if (!run) return null;
  if (run.releasedAt) return { version: run.version, outcome: 'shipped' };
  if (run.status === 'running' || run.status === 'paused') {
    return { version: run.version, outcome: 'open' };
  }
  return { version: run.version, outcome: 'failed' };
}
