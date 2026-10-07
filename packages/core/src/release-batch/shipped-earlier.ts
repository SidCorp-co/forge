/**
 * An issue at `awaiting_release` whose landing commit an earlier release already shipped.
 *
 * It arises when a mark is written after the cut whose range already holds the commit: that release
 * never claimed the issue, and every later one finds nothing new in its own range and aborts naming
 * a person. A commit that is an ancestor of a release Forge verified shipping is a kernel fact, so
 * the issue is recorded as shipped IN THAT RELEASE — the earliest verified one holding the commit —
 * and closed through the release path: the claim, `closeRoster`'s transition and the claim's release
 * (`releasing-recovery.ts` `releaseClaims`, which adds the issue to the run's `rosterClosed`) are the
 * writers a release finish uses, not a second close path.
 *
 * What counts as a published release is a run whose finish record reads `finished`, whose ship stamp
 * is set, and whose `finish.commit` is the commit the probes verified live. Two evidences place an
 * issue in one:
 *
 * - an `observed` mark names a commit; the release is the earliest whose commit holds it.
 * - an `asserted` mark names none (it is somebody's word that the work shipped), so the repository
 *   is asked instead which commits declare the issue (`commitOwners`, the rule the live reading
 *   places commits with) in each recent release's own range. The issue is placed in the release
 *   whose range holds its last declaring commit, and only where the range between the newest
 *   shipped release and the branch head holds none: work still unreleased is not shipped.
 *
 * Anything the repository cannot answer is a refusal by name and writes nothing: the issue takes
 * today's path, and a version is never inferred from a commit that could not be placed.
 */

import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns, projects } from '../db/schema.js';
import {
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { accountActor, claimIssuesForRelease, mergeMarkKindOf } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { closeRoster } from './finish.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { clearReleaseHolds } from './hold.js';
import { releaseClaims } from './releasing-recovery.js';
import type { ShippedEarlierUnsettled } from './shipped-earlier-hold.js';
import { placeByKey, type ShippedRelease } from './shipped-earlier-keyed.js';

/** One issue closed against the release that shipped its commit. */
interface ClosedEarlier {
  issueId: string;
  version: string;
  runId: string;
  commit: string;
  /** What placed it there, in words the issue's notice repeats. */
  evidence: string;
}

/**
 * One issue the pass could not settle, and the name of why. Nothing about the issue moves; the
 * sweep says it on the row's hold (`shipped-earlier-hold.ts`).
 */
interface Unresolved extends ShippedEarlierUnsettled {
  issueId: string;
}

export interface ShippedEarlierResult {
  closed: ClosedEarlier[];
  unresolved: Unresolved[];
}

export interface ShippedEarlierDeps {
  host?: (projectId: string) => Promise<SourceHost>;
}

interface ShippedEarlierArgs {
  projectId: string;
  issueIds: readonly string[];
  /** The account the notice and the close are written as; the project's own device where none. */
  userId: string | null;
}

const NOTHING: ShippedEarlierResult = { closed: [], unresolved: [] };

// An ancestry answer that was "no" for the newest shipped release stays no until a newer one ships,
// so a held row is not asked about again every tick. Keyed by the pair it answered for.
const NOT_SHIPPED = new Set<string>();
const NOT_SHIPPED_LIMIT = 5_000;

/** Releases that shipped, oldest first. */
async function shippedReleases(projectId: string): Promise<ShippedRelease[]> {
  const rows = await db
    .select({
      runId: pipelineRuns.id,
      version: pipelineRuns.releaseVersion,
      commit: sql<string | null>`${pipelineRuns.metadata} -> 'finish' ->> 'commit'`,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        sql`${pipelineRuns.metadata} ->> 'source' = 'release-batch'`,
        sql`${pipelineRuns.metadata} -> 'finish' ->> 'state' = 'finished'`,
        isNotNull(pipelineRuns.releaseVersion),
        isNotNull(pipelineRuns.releaseReleasedAt),
      ),
    )
    .orderBy(asc(pipelineRuns.releaseReleasedAt), asc(pipelineRuns.id));
  return rows.flatMap((r) =>
    r.version && r.commit && /^[0-9a-f]{40}$/i.test(r.commit)
      ? [{ runId: r.runId, version: r.version, commit: r.commit.toLowerCase() }]
      : [],
  );
}

/** Whether `release`'s commit holds `sha`: the release is at or ahead of it. */
async function holds(host: SourceHost, sha: string, release: ShippedRelease): Promise<boolean> {
  const status = await host.compare(sha, release.commit);
  return status === 'ahead' || status === 'identical';
}

/**
 * The earliest of `releases` (oldest first) that holds `sha`, or null where the newest does not.
 * Releases on one branch only ever gain commits, so a release holding the commit is followed by
 * releases holding it and the earliest is found by halving.
 */
async function earliestHolding(
  host: SourceHost,
  sha: string,
  releases: readonly ShippedRelease[],
): Promise<ShippedRelease | null> {
  const newest = releases[releases.length - 1];
  if (!newest) return null;
  const key = `${sha}@${newest.commit}`;
  if (NOT_SHIPPED.has(key)) return null;
  if (!(await holds(host, sha, newest))) {
    if (NOT_SHIPPED.size >= NOT_SHIPPED_LIMIT) NOT_SHIPPED.clear();
    NOT_SHIPPED.add(key);
    return null;
  }
  let lo = 0;
  let hi = releases.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await holds(host, sha, releases[mid] as ShippedRelease)) hi = mid;
    else lo = mid + 1;
  }
  return releases[lo] ?? null;
}

interface Candidate {
  id: string;
  status: IssueStatus;
  reopenCount: number;
  issSeq: number;
  /** The commit an `observed` mark names; null on an `asserted` one, which names none. */
  sha: string | null;
}

/** The waiting, unclaimed rows an earlier release could have shipped: observed and asserted marks. */
async function candidatesOf(projectId: string, issueIds: readonly string[]): Promise<Candidate[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .select({
      id: issues.id,
      status: issues.status,
      reopenCount: issues.reopenCount,
      issSeq: issues.issSeq,
      mergedAt: issues.mergedAt,
      sha: issues.mergedCommitSha,
      landing: issues.mergedLanding,
    })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        inArray(issues.id, [...issueIds]),
        eq(issues.status, RELEASE_GATE_STATUS),
        isNull(issues.releaseBatchRunId),
      ),
    );
  return rows.flatMap((r): Candidate[] => {
    const kind = mergeMarkKindOf({
      mergedAt: r.mergedAt,
      mergedCommitSha: r.sha,
      mergedLanding: r.landing,
    });
    const base = { id: r.id, status: r.status, reopenCount: r.reopenCount, issSeq: r.issSeq };
    if (kind === 'asserted' && r.issSeq != null) return [{ ...base, sha: null }];
    if (kind === 'observed' && r.issSeq != null && r.sha && /^[0-9a-f]{40}$/i.test(r.sha)) {
      return [{ ...base, sha: r.sha.toLowerCase() }];
    }
    return [];
  });
}

async function readerFor(
  projectId: string,
  deps: ShippedEarlierDeps,
): Promise<SourceHost | { why: string }> {
  try {
    return await (deps.host ?? ((id) => resolveSourceHost(id, 'kernel')))(projectId);
  } catch (err) {
    if (err instanceof SourceHostUnavailable) return { why: err.message };
    throw err;
  }
}

/**
 * The commit each `asserted` mark's own audit comment recorded as the caller's claim. The tracker
 * keeps no structured field for it (`merge-marker.ts` `writeMarkTrail` writes it into the audit
 * comment's first line as `commit=<40 hex>`), so the latest such comment that stamped is read, in
 * exactly that shape and no other. It is the caller's word, and is used only as a lead the host
 * then has to confirm.
 */
async function claimedCommits(issueIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (issueIds.length === 0) return out;
  const found = await db.execute<{ issue_id: string; sha: string }>(sql`
    SELECT DISTINCT ON (c.issue_id) c.issue_id,
           substring(split_part(c.body, E'\\n', 1) from '^mark_merged(?: target=\\S+)? commit=([0-9a-f]{40})(?: |$)') AS sha
      FROM comments c
     WHERE c.issue_id IN (${sql.join(
       issueIds.map((id) => sql`${id}`),
       sql`, `,
     )})
       AND c.body LIKE 'mark_merged%'
       AND c.body NOT LIKE '%NOT stamped by this call%'
       AND split_part(c.body, E'\\n', 1) ~ '^mark_merged( target=\\S+)? commit=[0-9a-f]{40}( |$)'
     ORDER BY c.issue_id, c.created_at DESC
  `);
  for (const r of found) out.set(r.issue_id, r.sha.toLowerCase());
  return out;
}

/** The comment the issue carries, naming what the record shows. */
function noticeFor(found: ClosedEarlier): string {
  return (
    `Shipped in ${found.version} before this issue reached \`awaiting_release\`: ${found.evidence}. ` +
    `It is closed against that release, which was verified serving \`${found.commit}\`, and no ` +
    `later release carries it. It adds no changelog fragment of its own: its notes belong to ${found.version}.`
  );
}

/**
 * Close, against the release that shipped it, each of `issueIds` whose landing commit an earlier
 * published release holds. Issues it does not close are left exactly as they were: a row held for a
 * person by an aborted release is read again here, and a hold on a closed row is cleared. What it
 * could not settle is returned as `unresolved`, which the caller owes to the row's hold.
 */
export async function closeShippedEarlier(
  args: ShippedEarlierArgs,
  deps: ShippedEarlierDeps = {},
): Promise<ShippedEarlierResult> {
  const { projectId } = args;
  const waiting = await candidatesOf(projectId, args.issueIds);
  if (waiting.length === 0) return NOTHING;
  const releases = await shippedReleases(projectId);
  if (releases.length === 0) return NOTHING;

  const host = await readerFor(projectId, deps);
  if ('why' in host) {
    const detail = `the project's repository could not be read, so whether these issues shipped in an earlier release was not decided: ${host.why}`;
    logger.warn({ projectId, issues: waiting.length }, `release-shipped-earlier: ${detail}`);
    return {
      closed: [],
      unresolved: waiting.map((w) => ({
        issueId: w.id,
        code: 'SHIPPED_EARLIER_HOST_UNAVAILABLE' as const,
        detail,
      })),
    };
  }

  const unresolved: Unresolved[] = [];
  const placement = new Map<string, { release: ShippedRelease; evidence: string }>();
  const claimedBy = await claimedCommits(waiting.filter((w) => w.sha === null).map((w) => w.id));
  for (const row of waiting) {
    const lead = row.sha ?? claimedBy.get(row.id) ?? null;
    if (lead === null) continue;
    try {
      const release = await earliestHolding(host, lead, releases);
      if (release) {
        placement.set(row.id, {
          release,
          evidence:
            row.sha === null
              ? `the commit its mark claimed, \`${lead}\`, is an ancestor of the release's`
              : `its landing commit \`${lead}\` is an ancestor of the release's`,
        });
      }
    } catch (err) {
      const detail = `commit ${lead} could not be placed against the releases that shipped: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn({ projectId, issueId: row.id }, `release-shipped-earlier: ${detail}`);
      unresolved.push({ issueId: row.id, code: 'SHIPPED_EARLIER_UNREAD', detail });
    }
  }
  const keyed = waiting.filter((w) => w.sha === null && !placement.has(w.id));
  try {
    for (const [id, release] of await placeByKey(host, projectId, releases, keyed)) {
      placement.set(id, {
        release,
        evidence:
          "the last commit declaring it is in that release's range, and none is left unreleased",
      });
    }
  } catch (err) {
    const detail = `the commits declaring these issues could not be placed against the releases that shipped: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ projectId, issues: keyed.length }, `release-shipped-earlier: ${detail}`);
    for (const row of keyed) {
      unresolved.push({ issueId: row.id, code: 'SHIPPED_EARLIER_UNREAD', detail });
    }
  }
  const byRelease = new Map<string, { release: ShippedRelease; rows: Candidate[] }>();
  for (const row of waiting) {
    const placed = placement.get(row.id);
    if (!placed) continue;
    const group = byRelease.get(placed.release.runId) ?? { release: placed.release, rows: [] };
    group.rows.push(row);
    byRelease.set(placed.release.runId, group);
  }

  const closed: ClosedEarlier[] = [];
  const actor = await actorFor(projectId, args.userId);
  for (const { release, rows } of byRelease.values()) {
    const claimed = new Set(
      (
        await claimIssuesForRelease({
          projectId,
          issueIds: rows.map((r) => r.id),
          gateStatus: RELEASE_GATE_STATUS,
          runId: release.runId,
        })
      ).map((c) => c.id),
    );
    try {
      const outcome = await closeRoster(
        rows.filter((r) => claimed.has(r.id)).map((r) => ({ ...r, projectId })),
        release.runId,
        actor,
        undefined,
      );
      for (const id of outcome.closed) {
        const found = {
          issueId: id,
          version: release.version,
          runId: release.runId,
          commit: release.commit,
          evidence: placement.get(id)?.evidence ?? 'a release holds its commits',
        };
        closed.push(found);
        if (args.userId) {
          try {
            await postIssueNotice({ issueId: id, authorId: args.userId, body: noticeFor(found) });
          } catch (err) {
            logger.warn({ err, issueId: id }, 'release-shipped-earlier: the notice was not posted');
          }
        }
      }
      for (const f of outcome.failed) {
        unresolved.push({
          issueId: f.id,
          code: 'SHIPPED_EARLIER_NOT_CLOSED',
          detail: `closing it against ${release.version} was refused: ${f.reason}`,
        });
      }
    } finally {
      // The claim was a lock for this write only: a row that did not close must not stay claimed.
      await db.transaction((tx) => releaseClaims(tx, release.runId));
    }
  }

  await clearReleaseHolds(closed.map((c) => c.issueId));
  if (closed.length > 0) {
    logger.info(
      { projectId, closed: closed.map((c) => `${c.issueId}@${c.version}`) },
      'release-shipped-earlier: issues closed against the earlier release that shipped their commit',
    );
  }
  return { closed, unresolved };
}

async function actorFor(projectId: string, userId: string | null) {
  if (userId) return accountActor(userId);
  const [project] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const id = project?.createdBy ?? projectId;
  return { type: 'device' as const, id, ownerId: id };
}
