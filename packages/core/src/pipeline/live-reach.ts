/**
 * Whether a merged issue's work is on production, answered from the releases Forge recorded shipping
 * and the issue's own merge mark, never from a compare of the project's branches (owner, 2026-10-30:
 * agents record, Forge never infers; ISS-774: a read path never calls the source host). It is read
 * on a project whose production deploys from a branch a promotion crosses into (`deploysFrom`, which
 * the caller reads from the project's document), as the issue page's live reach and the pulse's
 * "closed, not on production" did when they compared the branches.
 *
 * A shipped release carrying the issue (`release-runs.ts:shippedReleasesOf`, the one reading the
 * issue page's "Shipped in" also takes) places it on production. A record also says when it is not
 * there: a release that claims it has not shipped, or it landed after the newest shipped release was
 * cut. Where no record says either (no release has shipped, or one cut after the landing does not
 * name it) the answer is `unrecorded`, naming the record that is missing and who owes it; it is
 * never read as live.
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns } from '../db/schema.js';
import { heldByEndedRelease } from '../issues/index.js';
import { shippedReleasesOf } from './release-runs.js';

/** Where merged work waits for a release: the only status a release takes work from. */
const AWAITING_RELEASE: IssueStatus = 'awaiting_release';

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
  | (Placed & { state: 'on_live'; release: { version: string; shippedAt: string } })
  | (Placed & { state: 'not_on_live'; why: string; owes: string })
  | (Placed & {
      state: 'unrecorded';
      /** `no_release`: nothing has shipped on the project; `not_named`: a release cut after it does not name it. */
      cause: 'no_release' | 'not_named';
      missing: string;
      owes: string;
    });

interface ShippedCut {
  version: string;
  cutAt: Date;
}

/** The releases that shipped on a project, by when each was cut, oldest first. */
async function shippedCuts(projectId: string): Promise<ShippedCut[]> {
  const rows = await db
    .select({ version: pipelineRuns.releaseVersion, cutAt: pipelineRuns.createdAt })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        sql`${pipelineRuns.metadata} ->> 'source' = 'release-batch'`,
        isNotNull(pipelineRuns.releaseVersion),
        isNotNull(pipelineRuns.releaseReleasedAt),
      ),
    )
    .orderBy(asc(pipelineRuns.createdAt));
  return rows.flatMap((r) => (r.version ? [{ version: r.version, cutAt: r.cutAt }] : []));
}

/** A release claiming an issue that has not shipped and has not ended, by issue id. */
async function unshippedClaimsOf(
  ids: readonly string[],
): Promise<Map<string, { runId: string; version: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: issues.id,
      runId: issues.releaseBatchRunId,
      version: pipelineRuns.releaseVersion,
    })
    .from(issues)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .where(
      and(
        inArray(issues.id, [...ids]),
        sql`${pipelineRuns.releaseReleasedAt} IS NULL`,
        sql`NOT ${heldByEndedRelease(sql`${issues.releaseBatchRunId}`)}`,
      ),
    );
  return new Map(
    rows.flatMap((r) => (r.runId ? [[r.id, { runId: r.runId, version: r.version }] as const] : [])),
  );
}

/** Who owes the release that places work landed after the newest shipped one, by the issue's status. */
function nextReleaseOwed(status: string): string {
  if (status === AWAITING_RELEASE) {
    return 'the next release on this project, which takes it from `awaiting_release`';
  }
  if (status === 'closed') {
    return 'a release naming it: it was closed outside one, and a release takes work only from `awaiting_release`';
  }
  return `its release, once it is at \`awaiting_release\`: it is \`${status}\``;
}

/** Who owes the record of which shipped release holds a landing no release names, by status. */
function shippedInOwed(status: string): string {
  if (status === AWAITING_RELEASE) {
    return 'its agent, who reads with git which shipped release holds the landing and records it: POST /api/projects/:id/shipped-in-records { issueId, version, evidence }, `version: null` where none does';
  }
  return `no door records it for a \`${status}\` issue: a shipped-in record is taken only at \`awaiting_release\``;
}

/** One issue's answer where no shipped release carries it, against the project's shipped cuts. */
function offOrUnrecorded(
  issue: LiveReachIssue,
  placed: Placed,
  landedAt: Date,
  cuts: readonly ShippedCut[],
  claim: { runId: string; version: string | null } | undefined,
): LiveReach {
  if (claim) {
    const named = claim.version ? `release ${claim.version}` : `release run ${claim.runId}`;
    return {
      ...placed,
      state: 'not_on_live',
      why: `${named} carries it and has not been recorded shipping`,
      owes: `${named}, whose finish records it shipped once production is verified serving it`,
    };
  }
  const newest = cuts.at(-1);
  if (!newest) {
    return {
      ...placed,
      state: 'unrecorded',
      cause: 'no_release',
      missing: `a release recorded shipping: no release on this project has shipped through Forge, so no record places its work on \`${placed.deploysFrom}\``,
      owes: 'the release actor, who cuts and ships a release through Forge',
    };
  }
  if (landedAt > newest.cutAt) {
    return {
      ...placed,
      state: 'not_on_live',
      why: `it landed at ${placed.landedAt}, after ${newest.version} (the newest release shipped) was cut at ${newest.cutAt.toISOString()}`,
      owes: nextReleaseOwed(issue.status),
    };
  }
  const after = cuts.find((r) => r.cutAt >= landedAt) ?? newest;
  return {
    ...placed,
    state: 'unrecorded',
    cause: 'not_named',
    missing: `a record of which release holds its landing: ${after.version} was cut after it landed and does not name it`,
    owes: shippedInOwed(issue.status),
  };
}

/**
 * Each merged issue's live reach, by issue id, on a project whose production deploys from
 * `deploysFrom`, a promoted branch; empty where it is null, and for an issue with no merge mark.
 */
export async function liveReachOfIssues(
  projectId: string,
  rows: readonly LiveReachIssue[],
  deploysFrom: string | null,
): Promise<Map<string, LiveReach>> {
  const out = new Map<string, LiveReach>();
  const merged = rows.flatMap((r) =>
    r.mergedAt == null ? [] : [{ issue: r, landedAt: new Date(r.mergedAt) }],
  );
  if (!deploysFrom || merged.length === 0) return out;
  const ids = merged.map((m) => m.issue.id);
  const [shipped, cuts, claims] = await Promise.all([
    shippedReleasesOf(projectId, ids),
    shippedCuts(projectId),
    unshippedClaimsOf(ids),
  ]);
  for (const { issue, landedAt } of merged) {
    const placed: Placed = {
      deploysFrom,
      landedAt: landedAt.toISOString(),
      commit: issue.mergedCommitSha?.toLowerCase() ?? null,
    };
    const release = shipped.get(issue.id);
    out.set(
      issue.id,
      release
        ? {
            ...placed,
            state: 'on_live',
            release: { version: release.version, shippedAt: release.at },
          }
        : offOrUnrecorded(issue, placed, landedAt, cuts, claims.get(issue.id)),
    );
  }
  return out;
}
