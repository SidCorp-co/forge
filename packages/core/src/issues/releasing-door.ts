// `releasing` means a release batch run is carrying the issue to production right now (ISS-1421).
// So one door writes it — creating a release batch, which names its run — and only the release
// paths take an issue off it: the batch's finish, its abort, the recovery of a run that stopped,
// never started or whose job nothing will send, and the sweep that settles a row whose run has
// ended. Every other door asking for either move is refused here, by name.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns } from '../db/schema.js';
import { RELEASE_GATE_STATUS } from '../release-batch/gate.js';
import { projectPages } from '../release-batch/release-links.js';
import {
  type GateHolds,
  NO_DOORS,
  NO_HOLDS,
  type ReleaseDoors,
  type ReleasePath,
  readGateHolds,
  readReleaseDoors,
  readReleasePath,
  releaseStartsFor,
} from '../release-batch/release-path-words.js';
import { statusForCaller } from './status-sets.js';
import { TransitionError } from './transition-error.js';

export const RELEASING: IssueStatus = 'releasing';

export interface ReleasingDoorAsk {
  issueId: string;
  projectId: string;
  from: IssueStatus;
  to: IssueStatus;
  /** The release batch run this move enters `releasing` under; only `createReleaseBatch` names one. */
  releaseRun?: string | undefined;
  /** This move is a release path's own: a finish, an abort or recovery, a record, the sweep. */
  viaReleasePath?: boolean | undefined;
}

export function releasingEntryRefusal(
  projectId: string,
  from: IssueStatus,
  path: ReleasePath,
  holds: GateHolds = NO_HOLDS,
  doors: ReleaseDoors = NO_DOORS,
): TransitionError {
  return new TransitionError(
    'RELEASING_STARTS_FROM_RELEASE',
    [
      `${statusForCaller(RELEASING)} means a release batch is carrying this issue to production right now.`,
      'Only starting a release puts an issue there.',
      ...releaseStartsFor(path, projectId, from, holds, doors),
      `The issue stays at ${statusForCaller(from)}.`,
    ].join(' '),
    {
      from,
      to: RELEASING,
      releasePath: path,
      ...(doors.addLiveTarget ? { addLiveTarget: doors.addLiveTarget } : {}),
    },
  );
}

/** The entry refusal, read against what the issue's own page would offer it. */
async function entryRefusal(ask: ReleasingDoorAsk): Promise<TransitionError> {
  const path = await readReleasePath(ask.projectId);
  const atGate = path === 'gated' && ask.from === RELEASE_GATE_STATUS;
  const holds = atGate ? await readGateHolds(ask.projectId, ask.issueId) : NO_HOLDS;
  const doors = await readReleaseDoors(ask.projectId, path);
  return releasingEntryRefusal(ask.projectId, ask.from, path, holds, doors);
}

async function claimingRun(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ run: issues.releaseBatchRunId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.run ?? null;
}

export async function releasingExitRefusal(
  ask: Pick<ReleasingDoorAsk, 'issueId' | 'projectId' | 'to'>,
): Promise<TransitionError> {
  const runId = await claimingRun(ask.issueId);
  // A page a person can open, never an API route with the run's id in it (ISS-1421 r5).
  const pages = runId ? await projectPages(ask.projectId) : null;
  const where = runId
    ? pages
      ? [`The release carrying it shows where it stands at ${pages.releaseRun(runId)}.`]
      : ['A release is carrying it now.']
    : [
        'No release carries it, so the releasing sweep returns it to the release gate within a minute.',
      ];
  return new TransitionError(
    'RELEASING_ENDS_BY_RELEASE',
    [
      `${statusForCaller(RELEASING)} is left only through the release carrying the issue.`,
      'Its finish closes the issue.',
      'Its abort, or the recovery of a release that stopped or could not go on, returns it to the release gate.',
      'The releasing sweep settles an issue whose release has ended.',
      ...where,
      `The issue stays at ${statusForCaller(RELEASING)}, and ${statusForCaller(ask.to)} was not written.`,
    ].join(' '),
    { from: RELEASING, to: ask.to, releaseBatchRunId: runId },
  );
}

/** Why this move may not touch `releasing`, or `null` where it may. */
export async function releasingDoorRefusal(ask: ReleasingDoorAsk): Promise<TransitionError | null> {
  if (ask.releaseRun !== undefined && ask.to !== RELEASING) {
    throw new Error(
      `releaseRun names the run a move ENTERS ${statusForCaller(RELEASING)} under, and this move goes to ${statusForCaller(ask.to)}`,
    );
  }
  if (ask.to === RELEASING && ask.from !== RELEASING && ask.releaseRun === undefined) {
    return entryRefusal(ask);
  }
  if (ask.from === RELEASING && ask.to !== RELEASING && ask.viaReleasePath !== true) {
    return releasingExitRefusal(ask);
  }
  return null;
}

/**
 * The entry's UPDATE also requires the issue unclaimed and the run running, so a zero-row result
 * does not say which failed. Re-read all three and name it; the batch answers a lost claim as its
 * own CLAIM_CONFLICT.
 */
export async function explainReleasingRace(
  issueId: string,
  from: IssueStatus,
  runId: string,
): Promise<TransitionError> {
  const [row] = await db
    .select({ status: issues.status, claimedBy: issues.releaseBatchRunId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const [run] = await db
    .select({ status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  const details = {
    from,
    to: RELEASING,
    raced: true,
    releaseRun: runId,
    observedStatus: row?.status ?? null,
    claimedBy: row?.claimedBy ?? null,
    runStatus: run?.status ?? null,
  };
  if (row && row.status !== from) {
    return new TransitionError(
      'STALE_TRANSITION',
      `issue status changed concurrently — it left ${statusForCaller(from)} for ${statusForCaller(row.status)} while the release was claiming it`,
      details,
    );
  }
  if (row?.claimedBy && row.claimedBy !== runId) {
    return new TransitionError(
      'STALE_TRANSITION',
      `release run ${row.claimedBy} claimed this issue while release run ${runId} was claiming it`,
      details,
    );
  }
  return new TransitionError(
    'STALE_TRANSITION',
    `release run ${runId} is ${run?.status ?? 'gone'}, not running, so nothing would carry this issue at ${statusForCaller(RELEASING)}`,
    details,
  );
}
