// The gate issues a release run still claims after it ended (ISS-961). The roster a cut reads is the
// unclaimed gate (`queries.ts:waitingIssueIds`), so an issue claimed by an ended run is in no roster;
// this is the one read that names it, the run holding it and the act that frees it, so every read of
// the next cut (readiness, the draft, the cut, the sweep, the releases list, the master's owed read)
// says it rather than leaving it out in silence. "Ended" is `claim-conflicts.ts:readClaimConflicts`'s
// reading, and which claim waits for its abort is `issues/release-claim.ts:keptForItsAbort`, the
// predicate the claims sweep keeps it by.

import type { ReleaseEndedRunHold } from '@forge/contracts/releases';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns } from '../db/schema.js';
import { keptForItsAbort } from '../issues/index.js';
import { agrees } from '../lib/plural.js';
import { readClaimConflicts } from './claim-conflicts.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { shippedReleaseRuns } from './shipped-releases.js';

type ClaimConflict = Awaited<ReturnType<typeof readClaimConflicts>>[number];

/** What the read needs of each run that holds a claim. */
export interface HoldingRun {
  id: string;
  status: string | null;
  version: string | null;
  cutAt: Date;
  /** Its ship stamp is set: production was verified serving it. */
  shipped: boolean;
}

/** A release that shipped, as `shipped-releases.ts:shippedReleaseRuns` reads it. */
export interface ShippedAfter {
  runId: string;
  version: string;
  cutAt: Date;
}

const keys = (list: { key: string }[]) => list.map((i) => i.key).join(', ');

/** The run, its issues and the act that frees them, as every read words it. */
export function endedRunSentence(projectId: string, hold: Omit<ReleaseEndedRunHold, 'sentence'>): string {
  const n = hold.issues.length;
  const release = hold.version ? `release ${hold.version}` : 'an unversioned release';
  const subject = `${keys(hold.issues)} ${agrees(n, 'is', 'are')} waiting at the release gate still claimed by ${release} (run ${hold.runId}), which ended \`${hold.runStatus}\``;
  const them = agrees(n, 'it', 'them');
  if (hold.act === 'sweep') {
    return `${subject}; the pipeline sweep lets go of ${agrees(n, 'that claim', 'those claims')} within a minute, and the next cut carries ${them}.`;
  }
  const abort = `POST /api/projects/${projectId}/release-batches/${hold.runId}/abort`;
  const shipped = hold.shippedIn
    ? ` Where git says ${hold.shippedIn}, which shipped after it was cut, carried ${agrees(n, 'its', 'their')} code, send \`"shippedIn":{"version":"${hold.shippedIn}","evidence":"<the git command and its answer>"}\` with it, which records ${them} as shipped there.`
    : '';
  return (
    `${subject} after recording a deploy and no ship, so no roster carries ${them} and the next cut would deploy ${agrees(n, 'its', 'their')} code with no record of ${them}. ` +
    `Its abort is owed: ${abort} with \`{"promotedRoster":"return-to-gate","carried":[…]}\`, \`carried\` naming each tag, commit, artifact or notice that left the box (\`[]\` where nothing did), which puts ${them} back at the gate for the next cut.${shipped}`
  );
}

/**
 * The ended runs holding gate issues, one entry each, in the order their first issue merged. A claim
 * by a live run is that run's own and is never named; a run that shipped holds nothing it owes an
 * abort for, so the sweep lets go of what it left. `kept` holds the issues whose claim the sweep keeps
 * for the abort (`keptForItsAbort`).
 */
export function endedRunHolds(
  projectId: string,
  conflicts: readonly ClaimConflict[],
  kept: ReadonlySet<string>,
  runs: ReadonlyMap<string, HoldingRun>,
  shipped: readonly ShippedAfter[],
): ReleaseEndedRunHold[] {
  const byRun = new Map<string, { issueId: string; key: string; kept: boolean }[]>();
  for (const c of conflicts) {
    if (c.standing !== 'claimed' || !c.runEnded) continue;
    byRun.set(c.runId, [
      ...(byRun.get(c.runId) ?? []),
      { issueId: c.id, key: c.key, kept: kept.has(c.id) },
    ]);
  }
  return [...byRun].map(([runId, claimed]) => {
    const run = runs.get(runId);
    const owesAbort = claimed.some((c) => c.kept) && run?.shipped !== true;
    const later = run
      ? shipped.filter((s) => s.runId !== runId && s.cutAt > run.cutAt).at(-1)
      : undefined;
    const hold: Omit<ReleaseEndedRunHold, 'sentence'> = {
      runId,
      version: run?.version ?? null,
      runStatus: run?.status ?? 'absent',
      issues: claimed.map(({ issueId, key }) => ({ issueId, key })),
      act: owesAbort ? 'abort' : 'sweep',
      shippedIn: owesAbort ? (later?.version ?? null) : null,
    };
    return { ...hold, sentence: endedRunSentence(projectId, hold) };
  });
}

/** Every ended run still claiming issues at this project's gate, with the act that frees each. */
export async function readEndedRunHolds(
  projectId: string,
  gateStatus: IssueStatus = RELEASE_GATE_STATUS,
): Promise<ReleaseEndedRunHold[]> {
  const claimed = await db
    .select({ id: issues.id, kept: sql<boolean>`${keptForItsAbort()}` })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.status, gateStatus),
        isNotNull(issues.releaseBatchRunId),
      ),
    )
    .orderBy(sql`${issues.mergedAt} ASC NULLS LAST`, asc(issues.id));
  if (claimed.length === 0) return [];
  const conflicts = await readClaimConflicts(
    projectId,
    gateStatus,
    claimed.map((r) => r.id),
  );
  const runIds = [
    ...new Set(conflicts.flatMap((c) => (c.standing === 'claimed' && c.runEnded ? [c.runId] : []))),
  ];
  if (runIds.length === 0) return [];
  const [runRows, shipped] = await Promise.all([
    db
      .select({
        id: pipelineRuns.id,
        status: pipelineRuns.status,
        version: pipelineRuns.releaseVersion,
        cutAt: pipelineRuns.createdAt,
        releasedAt: pipelineRuns.releaseReleasedAt,
      })
      .from(pipelineRuns)
      .where(inArray(pipelineRuns.id, runIds)),
    shippedReleaseRuns(projectId),
  ]);
  const runs = new Map(
    runRows.map((r) => [
      r.id,
      { id: r.id, status: r.status, version: r.version, cutAt: r.cutAt, shipped: r.releasedAt !== null },
    ]),
  );
  const kept = new Set(claimed.filter((r) => r.kept).map((r) => r.id));
  return endedRunHolds(projectId, conflicts, kept, runs, shipped);
}

/** Each held issue's id and key, across every hold, in the order the holds name them. */
export function heldIssues(holds: readonly ReleaseEndedRunHold[]): { issueId: string; key: string }[] {
  return holds.flatMap((h) => h.issues);
}
