/**
 * Which release shipped an issue whose merged mark came after that release was cut (ISS-774, owner
 * 2026-10-29: Forge tells the agent what is owed and the agent records it; nothing is inferred by a
 * hook or a sweep). The agent landed the work, a release was cut from a branch that already held it,
 * and only then was the mark written, so that release never claimed the issue and every later one
 * finds nothing of it in its own range.
 *
 * Forge reads that shape from its own rows alone, never the repository: the issue waits at the
 * release gate unclaimed, its landing (`issues.merged_at`) is no later than a shipped release's cut,
 * and its current mark was recorded after that cut. It is owed to the issue's agent, who checks with
 * its own git which release holds the landing and records it here: a version closes the issue into
 * that release, as its finish would have, and `none` says no shipped release holds it, so the next
 * release takes it. Forge refuses only what its own rows contradict: a release that never shipped,
 * or one cut before the issue landed, which cannot hold it (ISS-759).
 *
 * Two release runs make the same record as their own (ISS-888, owner ruling
 * `release-is-the-agents-record`): a finish records every late-marked landing it holds by that same
 * rule as shipped in the version it ships, and an abort whose roster an earlier release already
 * shipped records it there where it names that release, or holds it for the agent naming this
 * record, never for a person (`shipped-in-runs.ts`).
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { activityLog, type IssueStatus, issues } from '../db/schema.js';
import { resolveSourceHost } from '../integrations/source-host/index.js';
import {
  accountActor,
  claimIssuesForRelease,
  currentMarkTimes,
  filingAnsweredBy,
  heldByEndedRelease,
  issueDisplayIds,
  type MarkedCommit,
  markedCommitsOf,
  recordActivityTx,
  returnTakenClaims,
  type TransitionActor,
} from '../issues/index.js';
import { emitEvent } from '../outbox/index.js';
import { blocker } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';
import { closeRoster } from './close-roster.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { clearReleaseHolds, RELEASE_SHIPPED_IN_OWED, type ReleaseHold } from './hold.js';
import { refuseRelease } from './refuse.js';
import { releaseClaims } from './releasing-recovery.js';
import { type ShippedReleaseRun, shippedReleaseRuns } from './shipped-releases.js';

/** The record an agent's `none` leaves: no shipped release holds the landing, as of then. */
export const SHIPPED_IN_NONE = 'issue.shippedInNone';

/** What each owed issue owes, by issue id: the shipped releases it may have shipped in, oldest first,
 *  and the commit its mark names (observed, or as its agent stated it), which the agent checks. */
export type ShippedInOwed = ReadonlyMap<
  string,
  { releases: readonly ShippedReleaseRun[]; commit: MarkedCommit | null }
>;

/**
 * Of `issueIds`, those owing a record of the release that shipped them: unclaimed at the gate,
 * landed no later than a shipped release's cut, and marked after it. A `none` recorded after the
 * current mark settles it until the issue is marked again.
 */
export async function shippedInOwed(
  projectId: string,
  issueIds: readonly string[],
): Promise<ShippedInOwed> {
  return heldBy(projectId, issueIds, await shippedReleaseRuns(projectId), { markedAfterCut: true });
}

/** A release the containment is weighed against: when it was cut, and what its roster carried. */
interface CutRelease {
  cutAt: Date;
  issueIds: readonly string[];
}

/**
 * Of `issueIds`, each unclaimed at the gate whose landing one of `releases` holds by the one rule a
 * shipped-in record is held to from Forge's rows (ISS-759, `refuseCutBeforeLanding`): cut no earlier
 * than the issue landed, and not carrying it. With `markedAfterCut`, only a release cut before the
 * issue's current mark counts: the shape a late mark leaves (ISS-774). A `none` recorded after the
 * current mark settles a row until it is marked again.
 */
export async function heldBy<R extends CutRelease>(
  projectId: string,
  issueIds: readonly string[],
  releases: readonly R[],
  opts: { markedAfterCut: boolean },
): Promise<Map<string, { releases: readonly R[]; commit: MarkedCommit | null }>> {
  const out = new Map<string, { releases: readonly R[]; commit: MarkedCommit | null }>();
  if (issueIds.length === 0 || releases.length === 0) return out;
  const rows = await db
    .select({ id: issues.id, landedAt: issues.mergedAt })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        inArray(issues.id, [...issueIds]),
        eq(issues.status, RELEASE_GATE_STATUS),
        isNull(issues.releaseBatchRunId),
      ),
    );
  const landed = rows.flatMap((r) => (r.landedAt ? [{ id: r.id, landedAt: r.landedAt }] : []));
  if (landed.length === 0) return out;
  const ids = landed.map((r) => r.id);
  const [marked, none, commits] = await Promise.all([
    currentMarkTimes(ids),
    noneRecordedAt(ids),
    markedCommitsOf(ids),
  ]);
  for (const row of landed) {
    const markedAt = marked.get(row.id);
    if (!markedAt) continue;
    const settled = none.get(row.id);
    if (settled && settled >= markedAt) continue;
    const holding = releases.filter(
      (r) =>
        r.cutAt >= row.landedAt &&
        (!opts.markedAfterCut || r.cutAt < markedAt) &&
        !r.issueIds.includes(row.id),
    );
    if (holding.length > 0)
      out.set(row.id, { releases: holding, commit: commits.get(row.id) ?? null });
  }
  return out;
}

async function noneRecordedAt(issueIds: readonly string[]): Promise<Map<string, Date>> {
  const rows = await db
    .select({ issueId: activityLog.issueId, at: sql<Date>`max(${activityLog.createdAt})` })
    .from(activityLog)
    .where(
      and(inArray(activityLog.issueId, [...issueIds]), eq(activityLog.action, SHIPPED_IN_NONE)),
    )
    .groupBy(activityLog.issueId);
  return new Map(rows.map((r) => [r.issueId, new Date(r.at)]));
}

/**
 * The gate's reason a roster may not be cut while any of it owes a shipped-in record: a cut carrying
 * it would find nothing of it new (ISS-774). Null where none does.
 */
export async function shippedInBlocker(
  projectId: string,
  issueIds: readonly string[],
): Promise<ReleaseBlocker | null> {
  const owed = await shippedInOwed(projectId, issueIds);
  if (owed.size === 0) return null;
  const ids = [...owed.keys()];
  const versions = [
    ...new Set([...owed.values()].flatMap((o) => o.releases.map((r) => r.version))),
  ];
  const shown = await issueDisplayIds(ids);
  return blocker('RELEASE_SHIPPED_IN_OWED', {
    issueIds: ids,
    displayIds: ids.map((id) => shown.get(id) ?? id),
    versions,
  });
}

/** A release named in a shipped-in hold: its version, and the commit its finish named, where it named one. */
interface NamedRelease {
  version: string;
  commit: string | null;
}

/** What the agent checks: whether its landing is in each release named, or which release holds it. */
function checkClause(releases: readonly NamedRelease[], commit: MarkedCommit | null): string {
  const named = releases
    .map((r) => (r.commit ? `${r.version} at \`${r.commit}\`` : r.version))
    .join(', ');
  return commit
    ? `whether its landing \`${commit.sha}\` (${commit.provenance}) is in ${named}`
    : `which release holds its landing (${named} may)`;
}

const RECORD_IT =
  'record it: POST /api/projects/:id/shipped-in-records { issueId, version, evidence }, with ' +
  '`version: null` where none holds it.';

/** The hold an owed row waits under: the agent's act, never a person's and never the sweep's. */
export function shippedInHold(owed: {
  releases: readonly NamedRelease[];
  commit: MarkedCommit | null;
  /** Why the finish of the release that may hold it could not record it there (ISS-888). */
  refused?: string | undefined;
}): ReleaseHold {
  const versions = owed.releases.map((r) => r.version).join(', ');
  const refused = owed.refused
    ? ` Release ${versions} finished and could not record it as shipped there: ${owed.refused}.`
    : '';
  return {
    code: RELEASE_SHIPPED_IN_OWED,
    reason:
      `This issue landed before release ${versions} was cut and was marked merged only after, so ` +
      `that release never claimed it and no later release finds its work new.${refused} Check with ` +
      `git ${checkClause(owed.releases, owed.commit)}, and ${RECORD_IT}`,
    owes: 'agent',
    waitingFor: `the issue's agent to record which release shipped it (${versions})`,
  };
}

/**
 * The hold an aborted release leaves on a roster issue whose landing a shipped release cut after it
 * may already hold (ISS-888): whether it shipped is the agent's to read with git and record, so the
 * hold is the agent's whatever blocker the abort named, never a person's.
 */
export function abortShippedInHold(args: {
  version: string | null;
  reason: string;
  releases: readonly NamedRelease[];
  commit: MarkedCommit | null;
  refused?: string | undefined;
}): ReleaseHold {
  const release = args.version ? `Release ${args.version}` : 'The release';
  const versions = args.releases.map((r) => r.version).join(', ');
  const refused = args.refused ? ` Its record there was refused: ${args.refused}.` : '';
  return {
    code: RELEASE_SHIPPED_IN_OWED,
    reason:
      `${release} was aborted by its release run: ${args.reason} This issue landed before release ` +
      `${versions} was cut, which did not carry it, so its work may already have shipped there, and ` +
      `no automatic release cuts it again while this stands.${refused} Check with git ` +
      `${checkClause(args.releases, args.commit)}, and ${RECORD_IT}`,
    owes: 'agent',
    waitingFor: `the issue's agent to record which release shipped it (${versions})`,
  };
}

interface ShippedInArgs {
  projectId: string;
  issueId: string;
  /** The shipped release that holds the landing, or null where none does. */
  version: string | null;
  /** What the agent read to say so: the git command and its answer. */
  evidence: string;
  userId: string;
}

export type ShippedInResult =
  | { issueId: string; version: string; runId: string; closed: true }
  | { issueId: string; version: null; closed: false };

/** The row a shipped-in record is made on, as the record reads it. */
interface ShippedInRow {
  id: string;
  status: IssueStatus;
  reopenCount: number;
  issSeq: number;
  landedAt: Date | null;
  claimedBy: string | null;
  endedClaim: boolean;
}

export async function readShippedInRow(
  projectId: string,
  issueId: string,
): Promise<ShippedInRow | undefined> {
  const [row] = await db
    .select({
      id: issues.id,
      status: issues.status,
      reopenCount: issues.reopenCount,
      issSeq: issues.issSeq,
      landedAt: issues.mergedAt,
      claimedBy: issues.releaseBatchRunId,
      // a release that ended without shipping still claims it: a row its person may record
      endedClaim: sql<boolean>`${heldByEndedRelease(sql`${issues.releaseBatchRunId}`)}`,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.id, issueId)))
    .limit(1);
  return row;
}

/** A release an issue is recorded as shipped in: its run, version, cut, and the commit it named. */
export interface ShippingRelease {
  runId: string;
  version: string;
  cutAt: Date;
  /** What its finish named, kept as evidence; null where it named none. */
  commit: string | null;
}

/**
 * The containment a shipped-in record is held to from Forge's own rows (ISS-759): a release cut
 * before the issue landed cannot hold that landing. The record at a finish (`claimMarkedLate`) is held
 * to it too, so there is one rule, not two.
 */
export function refuseCutBeforeLanding(
  issSeq: number,
  landedAt: Date,
  release: ShippingRelease,
): void {
  if (release.cutAt >= landedAt) return;
  throw refuseRelease(
    'RELEASE_SHIPPED_IN_BEFORE_LANDING',
    `Release ${release.version} was cut at ${release.cutAt.toISOString()}, before ISS-${issSeq} landed at ${landedAt.toISOString()}, so it cannot hold that landing. Name the release cut after it, or \`version: null\`.`,
    '/version',
  );
}

/**
 * Closes the row into the release, as that release's finish would have: claimed for the write, closed,
 * its claim let go, the notice posted, and the outbox told, naming only this issue, since the
 * release's own `release.shipped` named none of it.
 */
export async function shipInto(args: {
  projectId: string;
  row: ShippedInRow;
  release: ShippingRelease;
  actor: TransitionActor;
  authorId: string;
  notice: string;
}): Promise<void> {
  const { row, release } = args;
  const took = await claimIssuesForRelease({
    projectId: args.projectId,
    issueIds: [row.id],
    gateStatus: row.status,
    runId: release.runId,
    fromEndedRelease: true,
  });
  if (took.length === 0) {
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_NOT_WAITING',
      `ISS-${row.issSeq} was claimed by another writer while this record was made; read it again.`,
      '/issueId',
    );
  }
  try {
    const outcome = await closeRoster(
      [{ id: row.id, status: row.status, reopenCount: row.reopenCount, projectId: args.projectId }],
      release.runId,
      args.actor,
      undefined,
    );
    const failed = outcome.failed[0];
    if (failed) {
      throw refuseRelease(
        'RELEASE_SHIPPED_IN_NOT_WAITING',
        `ISS-${row.issSeq} could not be closed into ${release.version}: ${failed.reason}`,
        '/issueId',
      );
    }
  } finally {
    // the claim was a lock for this write only; a row taken from an ended release that did not close
    // goes back to it, held as before
    const fromEnded = took.flatMap((c) => (c.heldBy ? [{ id: c.id, heldBy: c.heldBy }] : []));
    await db.transaction(async (tx) => {
      await returnTakenClaims(tx, release.runId, fromEnded);
      await releaseClaims(tx, release.runId, [row.id]);
    });
  }
  await postIssueNotice({ issueId: row.id, authorId: args.authorId, body: args.notice });
  await emitEvent(db, 'release.shipped', {
    projectId: args.projectId,
    runId: release.runId,
    version: release.version,
    issueIds: [row.id],
  });
  await clearReleaseHolds([row.id]);
}

/** Records the agent's answer to an owed shipped-in, refusing only what Forge's rows contradict. */
export async function recordShippedIn(args: ShippedInArgs): Promise<ShippedInResult> {
  const row = await readShippedInRow(args.projectId, args.issueId);
  const live = row?.claimedBy != null && !row.endedClaim;
  // a draft filed for a merge its project owed a filing for closes on the release that shipped that
  // merge, from `draft`: its code landed before it was filed (ISS-774, the `filing_released` edge)
  const filing =
    row && row.status === 'draft' && !live && row.landedAt ? await filingAnsweredBy(row.id) : null;
  const waiting = row?.status === RELEASE_GATE_STATUS || filing !== null;
  if (!row || !waiting || live || !row.landedAt) {
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_NOT_WAITING',
      !row
        ? `No issue ${args.issueId} is on this project.`
        : live
          ? `ISS-${row.issSeq} is claimed by release run ${row.claimedBy}, still at work; that release closes it, not a shipped-in record.`
          : !row.landedAt
            ? `ISS-${row.issSeq} holds no merged mark, so there is no landing a release could have shipped: mark it merged first.`
            : row.status === 'draft'
              ? `ISS-${row.issSeq} is \`draft\`, and its landing is no merge this project owed a filing for: only such a draft, marked merged at that merge's commit and answering it alone, is recorded on the release that shipped it from \`draft\`.`
              : `ISS-${row.issSeq} is \`${row.status}\`; only an issue waiting at \`${RELEASE_GATE_STATUS}\`, or a draft filed for a merge its project owed a filing for, can be recorded as shipped by an earlier release.`,
      '/issueId',
    );
  }
  if (filing && args.version === null) {
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_NOT_WAITING',
      `ISS-${row.issSeq} is a draft filed for change request ${filing.number}, which landed at ${filing.commit}: no release cut carries a draft, so it is recorded only on a release that shipped that merge. Record it once one has, naming that release's version.`,
      '/version',
    );
  }
  if (args.version === null) {
    await recordActivityTx(db, {
      issueId: row.id,
      actor: { type: 'user', id: args.userId, agency: 'agent' },
      action: SHIPPED_IN_NONE,
      payload: { evidence: args.evidence },
    });
    await clearReleaseHolds([row.id]);
    return { issueId: row.id, version: null, closed: false };
  }
  const releases = await shippedReleaseRuns(args.projectId);
  const release = releases.find((r) => r.version === args.version);
  if (!release) {
    const shipped = releases
      .slice(-5)
      .map((r) => r.version)
      .join(', ');
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_UNKNOWN',
      `No release ${args.version} shipped on this project${shipped ? `; the newest that did are ${shipped}` : ''}. Name a shipped release, or send \`version: null\` where none holds the landing.`,
      '/version',
    );
  }
  refuseCutBeforeLanding(row.issSeq, row.landedAt, release);
  if (filing) await refuseUncontained(args.projectId, filing, release);
  await shipInto({
    projectId: args.projectId,
    row,
    release,
    actor: await accountActor(args.userId),
    authorId: args.userId,
    notice: filing
      ? `Shipped in ${release.version}, recorded by its agent: ${args.evidence}. ` +
        `This issue was filed for change request ${filing.number} after that merge landed at \`${filing.commit}\`, ` +
        `and ${release.version}'s commit \`${release.commit}\` contains it, as the repository answered; ` +
        `it is closed into ${release.version} from \`draft\`.`
      : `Shipped in ${release.version}, recorded by its agent: ${args.evidence}. ` +
        `That release was cut before this issue's merged mark was written, so it never claimed it; ` +
        `it is closed into ${release.version}, which was verified serving \`${release.commit}\`.`,
  });
  return { issueId: row.id, version: release.version, runId: release.runId, closed: true };
}

/**
 * A filing's record is checked against the repository, since nothing in Forge's rows says which
 * release holds a merge filed after it shipped: the release's own commit, the one it was verified
 * serving, must contain the merge. What production serves now is not asked, so the release that
 * first shipped it, or any later one whose commit descends from it, holds it.
 */
async function refuseUncontained(
  projectId: string,
  filing: { number: number; commit: string },
  release: ShippedReleaseRun,
): Promise<void> {
  let status: string;
  try {
    const host = await resolveSourceHost(projectId, 'kernel');
    status = await host.compare(filing.commit, release.commit);
  } catch (err) {
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_UNVERIFIED',
      `Whether ${release.version}'s commit \`${release.commit}\` contains \`${filing.commit}\` could not be read from this project's repository, so it is not recorded unchecked: ${err instanceof Error ? err.message : String(err)}. Record it again once the repository answers.`,
      '/version',
    );
  }
  if (status === 'ahead' || status === 'identical') return;
  throw refuseRelease(
    'RELEASE_SHIPPED_IN_NOT_CONTAINED',
    `${release.version}'s commit \`${release.commit}\` does not contain \`${filing.commit}\`, the merge of change request ${filing.number} this issue was filed for (the repository answers \`${status}\`), so that release did not ship it. Name a shipped release whose commit contains it.`,
    '/version',
  );
}
