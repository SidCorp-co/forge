/**
 * Whether a merged issue's work is on production, answered from the releases Forge recorded shipping
 * and the issue's own merge mark, never from a compare of the project's branches (owner, 2026-10-30:
 * agents record, Forge never infers; ISS-774: a read path never calls the source host). It is read
 * on a project whose production deploys from a branch a promotion crosses into, as the issue page's
 * live reach and the pulse's "closed, not on production" did when they compared the branches.
 *
 * A release that shipped and names the issue (its roster, or the issue's own claim) places it on
 * production. A record also says when it is not there: a release that claims it has not shipped,
 * or it landed after the newest shipped release was cut. Where no record says either (no release has
 * shipped, or one cut after the landing does not name it) the answer is `unrecorded`, naming the
 * record that is missing and who owes it; it is never read as live.
 */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { heldByEndedRelease } from '../issues/index.js';
import { promotedBranch, readReleasePath } from '../project-config/index.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { type ShippedReleaseRun, shippedReleaseRuns } from './shipped-releases.js';

/** The fields of an issue its live reach is read from. */
export interface LiveReachIssue {
  id: string;
  status: string;
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
}

interface Placed {
  /** The branch production deploys from, which a promotion crosses into. */
  deploysFrom: string;
  /** The issue's landing as its mark recorded it; `commit` is null where the mark named none. */
  landedAt: string;
  commit: string | null;
}

/** One merged issue's place on production, as Forge's records say it. */
export type LiveReach =
  | (Placed & {
      state: 'on_live';
      release: { version: string; commit: string; runId: string; cutAt: string };
    })
  | (Placed & { state: 'not_on_live'; why: string; owes: string })
  | (Placed & {
      state: 'unrecorded';
      /** `no_release`: nothing has shipped on the project; `not_named`: a release cut after it does not name it. */
      cause: 'no_release' | 'not_named';
      missing: string;
      owes: string;
    });

const short = (sha: string) => sha.slice(0, 12);

/** The branch a promotion carries work into for production, or null where none does. */
export async function deploysFromOf(projectId: string): Promise<string | null> {
  const read = await readReleasePath(projectId);
  return read.ok ? promotedBranch(read.path) : null;
}

interface Claim {
  runId: string;
  version: string | null;
  /** The claiming release ended without shipping, so its claim places nothing. */
  ended: boolean;
}

/** Each claimed issue's release, by issue id. */
async function claimsOf(ids: readonly string[]): Promise<Map<string, Claim>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: issues.id,
      runId: issues.releaseBatchRunId,
      version: pipelineRuns.releaseVersion,
      ended: sql<boolean>`${heldByEndedRelease(sql`${issues.releaseBatchRunId}`)}`,
    })
    .from(issues)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .where(and(inArray(issues.id, [...ids]), isNotNull(issues.releaseBatchRunId)));
  return new Map(
    rows.flatMap((r) =>
      r.runId ? [[r.id, { runId: r.runId, version: r.version, ended: r.ended }] as const] : [],
    ),
  );
}

/** Who owes the release that places work landed after the newest shipped one, by the issue's status. */
function nextReleaseOwed(status: string): string {
  if (status === RELEASE_GATE_STATUS)
    return 'the next release on this project, which takes it from `awaiting_release`';
  if (status === 'closed') {
    return 'a release naming it: it was closed outside one, and a release takes work only from `awaiting_release`';
  }
  return `its release, once it is at \`awaiting_release\`: it is \`${status}\``;
}

/** Who owes the record of which shipped release holds a landing no release names, by status. */
function shippedInOwed(status: string): string {
  if (status === RELEASE_GATE_STATUS) {
    return 'its agent, who reads with git which shipped release holds the landing and records it: POST /api/projects/:id/shipped-in-records { issueId, version, evidence }, `version: null` where none does';
  }
  return `no door records it for a \`${status}\` issue: a shipped-in record is taken only at \`awaiting_release\``;
}

/** One issue's answer against the project's shipped releases, oldest first. */
function reachOf(
  issue: LiveReachIssue & { landedAt: Date },
  deploysFrom: string,
  shipped: readonly ShippedReleaseRun[],
  claim: Claim | undefined,
): LiveReach {
  const placed: Placed = {
    deploysFrom,
    landedAt: issue.landedAt.toISOString(),
    commit: issue.mergedCommitSha?.toLowerCase() ?? null,
  };
  const carrying = shipped.find((r) => r.runId === claim?.runId || r.issueIds.includes(issue.id));
  if (carrying) {
    return {
      ...placed,
      state: 'on_live',
      release: {
        version: carrying.version,
        commit: carrying.commit,
        runId: carrying.runId,
        cutAt: carrying.cutAt.toISOString(),
      },
    };
  }
  if (claim && !claim.ended) {
    const named = claim.version ? `release ${claim.version}` : `release run ${claim.runId}`;
    return {
      ...placed,
      state: 'not_on_live',
      why: `${named} carries it and has not been recorded shipping`,
      owes: `${named}, whose finish records it shipped once production is verified serving it`,
    };
  }
  const newest = shipped.at(-1);
  if (!newest) {
    return {
      ...placed,
      state: 'unrecorded',
      cause: 'no_release',
      missing: `a release recorded shipping: no release on this project has shipped through Forge, so no record places its work on \`${deploysFrom}\``,
      owes: 'the release actor, who cuts and ships a release through Forge',
    };
  }
  if (issue.landedAt > newest.cutAt) {
    return {
      ...placed,
      state: 'not_on_live',
      why: `it landed at ${placed.landedAt}, after ${newest.version} (the newest release shipped, at ${short(newest.commit)}) was cut at ${newest.cutAt.toISOString()}`,
      owes: nextReleaseOwed(issue.status),
    };
  }
  const after = shipped.find((r) => r.cutAt >= issue.landedAt) ?? newest;
  return {
    ...placed,
    state: 'unrecorded',
    cause: 'not_named',
    missing: `a record of which release holds its landing: ${after.version} was cut after it landed and does not name it`,
    owes: shippedInOwed(issue.status),
  };
}

/**
 * Each merged issue's live reach, by issue id, on a project whose production deploys from a
 * promoted branch; empty on any other project, or for an issue with no merge mark.
 */
export async function liveReachOfIssues(
  projectId: string,
  rows: readonly LiveReachIssue[],
  deploysFrom?: string | null,
): Promise<Map<string, LiveReach>> {
  const out = new Map<string, LiveReach>();
  const merged = rows.flatMap((r) =>
    r.mergedAt == null ? [] : [{ ...r, landedAt: new Date(r.mergedAt) }],
  );
  if (merged.length === 0) return out;
  const branch = deploysFrom === undefined ? await deploysFromOf(projectId) : deploysFrom;
  if (!branch) return out;
  const shipped = await shippedReleaseRuns(projectId);
  const claims = await claimsOf(merged.map((r) => r.id));
  for (const r of merged) out.set(r.id, reachOf(r, branch, shipped, claims.get(r.id)));
  return out;
}

/** One issue's live reach; null where there is none to give (no promotion, or no merge mark). */
export async function liveReachForIssue(
  issue: LiveReachIssue & { projectId: string },
): Promise<LiveReach | null> {
  return (await liveReachOfIssues(issue.projectId, [issue])).get(issue.id) ?? null;
}
