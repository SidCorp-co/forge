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
 * Where the project has no source host binding (or declares a local repository no host serves), the
 * commit a mark names (observed, or the claim the marker's record of the current asserted mark
 * holds, `issues/mark-trail.ts:currentMarkClaims`, never one an unmark withdrew and never comment
 * text shaped like it) is asked of the
 * box holding the project's bound checkout instead (`shipped-earlier-ancestry.ts` `boxReader`), and
 * the issue's notice names that box-read evidence: the box, its checkout, origin and both shas. The
 * declaring-commits path stays host-only: it reads ranges of commit messages, which no box serves.
 *
 * A row a release that ended unshipped still claims is read too: a run that failed after it
 * deployed holds its roster at the release step for a person, and a later release holding the row's
 * commit is that person's answer. It is closed against that later release; a row no shipped release
 * holds stays claimed by the ended run, at its release step, exactly as it was.
 *
 * Anything the repository cannot answer is a refusal by name and writes nothing: the issue takes
 * today's path, and a version is never inferred from a commit that could not be placed.
 */

import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns, projects } from '../db/schema.js';
import {
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import {
  accountActor,
  claimIssuesForRelease,
  currentMarkClaims,
  heldByEndedRelease,
  mergeMarkKindOf,
  returnTakenClaims,
} from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { emitEvent } from '../outbox/index.js';
import { closeRoster } from './finish.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { clearReleaseHolds } from './hold.js';
import { releaseClaims } from './releasing-recovery.js';
import {
  type AncestryReader,
  type BoxDeps,
  boxReaderFor,
  hostReader,
  placeCommits,
  type Witness,
} from './shipped-earlier-ancestry.js';
import type { ShippedEarlierUnsettled } from './shipped-earlier-hold.js';
import { placeByKey, type ShippedRelease } from './shipped-earlier-keyed.js';
import { issueIdsOf } from './versions.js';

/** One issue closed against the release that shipped its commit. */
interface ClosedEarlier {
  issueId: string;
  version: string;
  runId: string;
  commit: string;
  /** What placed it there, in words the issue's notice repeats. */
  evidence: string;
  /** Who read the ancestry that placed it; absent where the declaring commits placed it. */
  witness?: Witness;
  /** The version of the release that claimed it and ended without shipping, where one held it. */
  heldBy?: string;
}

/**
 * One issue the pass could not settle, and the name of why. Nothing about the issue moves; the
 * sweep says it on the row's hold (`shipped-earlier-hold.ts`).
 */
interface Unresolved extends ShippedEarlierUnsettled {
  issueId: string;
}

interface ShippedEarlierResult {
  closed: ClosedEarlier[];
  unresolved: Unresolved[];
}

export interface ShippedEarlierDeps {
  host?: (projectId: string) => Promise<SourceHost>;
  /** How a box is asked where the project has no source host; the live socket where absent. */
  box?: BoxDeps;
}

interface ShippedEarlierArgs {
  projectId: string;
  issueIds: readonly string[];
  /** The account the notice and the close are written as; the project's own device where none. */
  userId: string | null;
}

const NOTHING: ShippedEarlierResult = { closed: [], unresolved: [] };

/** A shipped release with the issues it carries (`versions.ts:issueIdsOf`). */
export interface ShippedReleaseRun extends ShippedRelease {
  issueIds: string[];
}

/** Releases that shipped, oldest first, each with the issues it carries. */
export async function shippedReleaseRuns(projectId: string): Promise<ShippedReleaseRun[]> {
  const rows = await db
    .select({
      runId: pipelineRuns.id,
      version: pipelineRuns.releaseVersion,
      commit: sql<string | null>`${pipelineRuns.metadata} -> 'finish' ->> 'commit'`,
      metadata: pipelineRuns.metadata,
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
      ? [
          {
            runId: r.runId,
            version: r.version,
            commit: r.commit.toLowerCase(),
            issueIds: issueIdsOf((r.metadata ?? {}) as Record<string, unknown>),
          },
        ]
      : [],
  );
}

async function shippedReleases(projectId: string): Promise<ShippedRelease[]> {
  return (await shippedReleaseRuns(projectId)).map(({ runId, version, commit }) => ({
    runId,
    version,
    commit,
  }));
}

interface Candidate {
  id: string;
  status: IssueStatus;
  reopenCount: number;
  issSeq: number;
  /** The commit an `observed` mark names; null on an `asserted` one, which names none. */
  sha: string | null;
}

/**
 * The waiting rows an earlier release could have shipped, observed and asserted marks: unclaimed,
 * or still claimed by a release that ended without shipping (`heldByEndedRelease`). A run that
 * failed after it deployed keeps its roster for a person because the code may be live; a later
 * release verified serving a commit that holds the row's is what settles that, so the row is read
 * here like any other. A row a release still at work holds is never read.
 */
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
        or(isNull(issues.releaseBatchRunId), heldByEndedRelease(sql`${issues.releaseBatchRunId}`)),
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

export type AncestrySource =
  | { kind: 'host'; host: SourceHost; reader: AncestryReader }
  | { kind: 'box'; why: string; reader: AncestryReader }
  | { kind: 'none'; why: string };

/**
 * The source host, or why there is none and, where none is bound at all, the box reader that stands
 * in for it. A binding that exists and cannot serve stays its own refusal: a box never papers over it.
 */
export async function ancestrySourceFor(
  projectId: string,
  deps: ShippedEarlierDeps = {},
): Promise<AncestrySource> {
  try {
    const host = await (deps.host ?? ((id) => resolveSourceHost(id, 'kernel')))(projectId);
    return { kind: 'host', host, reader: hostReader(host) };
  } catch (err) {
    if (!(err instanceof SourceHostUnavailable)) throw err;
    if (err.reason !== 'no_binding' && err.reason !== 'local_repository') {
      return { kind: 'none', why: err.message };
    }
    return { kind: 'box', why: err.message, reader: await boxReaderFor(projectId, deps.box) };
  }
}

/** The evidence's provenance where a box read it, in the words the notice carries. */
function witnessed(witness: Witness): string {
  if (witness.via === 'source-host') return '';
  return (
    ` (box-read evidence: box ${witness.deviceId}, checkout ${witness.repoPath}, origin ${witness.origin}, ` +
    `read ${witness.readAt}${witness.fetched ? ' after a fetch' : ''}: ` +
    `\`git merge-base --is-ancestor ${witness.commit} ${witness.release}\` answered yes)`
  );
}

/** The comment the issue carries, naming what the record shows. */
function noticeFor(found: ClosedEarlier): string {
  const when = found.heldBy
    ? `while release ${found.heldBy}, which claimed it, ended without shipping and held it for a person`
    : 'before this issue reached `awaiting_release`';
  return (
    `Shipped in ${found.version} ${when}: ${found.evidence}. ` +
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

  const source = await ancestrySourceFor(projectId, deps);
  const unavailable = (why: string) =>
    `the project's repository could not be read, so whether these issues shipped in an earlier release was not decided: ${why}`;
  const refuse = (
    code: 'SHIPPED_EARLIER_HOST_UNAVAILABLE' | 'SHIPPED_EARLIER_NO_COMMIT',
    rows: readonly Candidate[],
    detail: string,
  ): Unresolved[] => {
    if (rows.length === 0) return [];
    logger.warn({ projectId, issues: rows.length }, `release-shipped-earlier: ${detail}`);
    return rows.map((w) => ({ issueId: w.id, code, detail }));
  };
  const hostUnavailable = (rows: readonly Candidate[], detail: string) =>
    refuse('SHIPPED_EARLIER_HOST_UNAVAILABLE', rows, detail);
  const noCommit = (rows: readonly Candidate[], detail: string) =>
    refuse('SHIPPED_EARLIER_NO_COMMIT', rows, detail);
  if (source.kind === 'none') {
    return { closed: [], unresolved: hostUnavailable(waiting, unavailable(source.why)) };
  }

  const unresolved: Unresolved[] = [];
  const placement = new Map<
    string,
    { release: ShippedRelease; evidence: string; witness?: Witness }
  >();
  // The current mark's own claim only: an unmark withdrew every earlier one (`issues/mark-trail.ts`).
  const claimedBy = await currentMarkClaims(waiting.filter((w) => w.sha === null).map((w) => w.id));
  const leads = new Map<string, string>();
  for (const row of waiting) {
    const lead = row.sha ?? claimedBy.get(row.id) ?? null;
    if (lead !== null) leads.set(row.id, lead);
  }
  const hostOnly = (why: string) =>
    `${unavailable(why)}; its mark names no commit, so only the commits declaring it can place it, which only a source host reads`;
  if (source.kind === 'box' && leads.size === 0) {
    return { closed: [], unresolved: noCommit(waiting, hostOnly(source.why)) };
  }
  const commits = await placeCommits(source.reader, [...leads.values()], releases);
  if ('silent' in commits) {
    const why = source.kind === 'box' ? source.why : 'the source host gave no answer';
    return {
      closed: [],
      unresolved: hostUnavailable(
        waiting,
        `${unavailable(why)}; nor did a box holding its checkout answer: ${commits.silent}`,
      ),
    };
  }
  for (const row of waiting) {
    const lead = leads.get(row.id);
    if (lead === undefined) continue;
    const placed = commits.placed.get(lead);
    if (placed) {
      const said =
        row.sha === null
          ? `the commit its mark claimed, \`${lead}\`, is an ancestor of the release's`
          : `its landing commit \`${lead}\` is an ancestor of the release's`;
      placement.set(row.id, {
        release: placed.release,
        evidence: `${said}${witnessed(placed.witness)}`,
        witness: placed.witness,
      });
      continue;
    }
    const why = commits.unread.get(lead);
    if (why === undefined) continue;
    const detail = `commit ${lead} could not be placed against the releases that shipped: ${why}`;
    logger.warn({ projectId, issueId: row.id }, `release-shipped-earlier: ${detail}`);
    unresolved.push({ issueId: row.id, code: 'SHIPPED_EARLIER_UNREAD', detail });
  }
  const keyed = waiting.filter((w) => w.sha === null && !placement.has(w.id));
  if (source.kind === 'box') {
    const unkeyed = keyed.filter((w) => !leads.has(w.id));
    unresolved.push(...noCommit(unkeyed, hostOnly(source.why)));
  } else {
    try {
      for (const [id, release] of await placeByKey(source.host, projectId, releases, keyed)) {
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
    const took = await claimIssuesForRelease({
      projectId,
      issueIds: rows.map((r) => r.id),
      gateStatus: RELEASE_GATE_STATUS,
      runId: release.runId,
      fromEndedRelease: true,
    });
    const claimed = new Set(took.map((c) => c.id));
    const fromEnded = took.flatMap((c) => (c.heldBy ? [{ id: c.id, heldBy: c.heldBy }] : []));
    try {
      const endedVersion = await versionsOf(fromEnded.map((c) => c.heldBy));
      const heldBy = new Map(fromEnded.map((c) => [c.id, endedVersion.get(c.heldBy) ?? c.heldBy]));
      const outcome = await closeRoster(
        rows.filter((r) => claimed.has(r.id)).map((r) => ({ ...r, projectId })),
        release.runId,
        actor,
        undefined,
      );
      for (const id of outcome.closed) {
        const placed = placement.get(id);
        const ended = heldBy.get(id);
        const found: ClosedEarlier = {
          issueId: id,
          version: release.version,
          runId: release.runId,
          commit: release.commit,
          evidence: placed?.evidence ?? 'a release holds its commits',
          ...(placed?.witness ? { witness: placed.witness } : {}),
          ...(ended ? { heldBy: ended } : {}),
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
      if (outcome.closed.length > 0) {
        // The release's own `release.shipped` went out before these issues were closed into it, so
        // it named none of them: tell the outbox again, naming only the late ones, or the reporter
        // whose feedback they carry is never told (the notice is once per item and release).
        await emitEvent(db, 'release.shipped', {
          projectId,
          runId: release.runId,
          version: release.version,
          issueIds: outcome.closed,
        });
      }
      for (const f of outcome.failed) {
        unresolved.push({
          issueId: f.id,
          code: 'SHIPPED_EARLIER_NOT_CLOSED',
          detail: `closing it against ${release.version} was refused: ${f.reason}`,
        });
      }
    } finally {
      // The claim was a lock for this write only: a row that did not close must not stay claimed by
      // this release. One taken from a release that ended unshipped goes back to it, held as before.
      // Only what this pass took is let go: another pass may hold rows on the same release.
      await db.transaction(async (tx) => {
        await returnTakenClaims(tx, release.runId, fromEnded);
        await releaseClaims(
          tx,
          release.runId,
          took.map((c) => c.id),
        );
      });
    }
  }

  await clearReleaseHolds(closed.map((c) => c.issueId));
  if (closed.length > 0) {
    logger.info(
      {
        projectId,
        closed: closed.map((c) => `${c.issueId}@${c.version}`),
        witnesses: closed.flatMap((c) => (c.witness?.via === 'box-read' ? [c.witness] : [])),
      },
      'release-shipped-earlier: issues closed against the earlier release that shipped their commit',
    );
  }
  return { closed, unresolved };
}

/** The version each release run wears, by run id. */
async function versionsOf(runIds: readonly string[]): Promise<Map<string, string>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({ id: pipelineRuns.id, version: pipelineRuns.releaseVersion })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.id, [...new Set(runIds)]));
  return new Map(rows.flatMap((r) => (r.version ? [[r.id, r.version] as const] : [])));
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
