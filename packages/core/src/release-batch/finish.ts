// The two ends of a release run, the only writers that end the release step: finish is the agent's
// record of the release under the version the batch was cut with, closes every claimed issue and
// completes the run; abort cancels it and closes no issue. Both hand the claims to
// `releasing-recovery.ts`. Forge reads no probe, deployment record or provider report to close, and
// replays no kept probe (owner ruling 2026-11-01, `release-is-the-agents-record`).

import type { ReleaseVersionCarrier } from '@forge/contracts/releases';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues, type PipelineRunStatus, pipelineRuns } from '../db/schema.js';
import type { TransitionActor } from '../issues/index.js';
import {
  cancelConcludedRun,
  closeRunIfOneShot,
  stampReleaseShipped,
  writeRunMetadata,
} from '../pipeline/index.js';
import {
  type AbortBlocker,
  abortedError,
  batchAborted,
  closedBeforeAbort,
  settleAbortStamp,
  stampAbort,
} from './abort-stamp.js';
import { recordCarried, refuseContradiction } from './carried.js';
import { type ClaimedRow, closeRoster, type RosterCloseResult } from './close-roster.js';
import { abortBlockedHold, heldFromUnattendedCut, writeReleaseHolds } from './hold.js';
import { RECORDED_VERIFICATION } from './recorded.js';
import { refuseRelease } from './refuse.js';
import {
  type RecoverStrandedReleasingResult,
  recoverStrandedReleasing,
} from './releasing-recovery.js';
import { holdResidue, markResidue } from './residue.js';
import {
  type AbortShippedOutcome,
  claimMarkedLate,
  settleAbortedShipped,
} from './shipped-in-runs.js';
import { lockRunVersions } from './version-store.js';

type FinishReleaseBatchResult = RosterCloseResult;

interface FinishReleaseBatchOptions {
  /** Called once the release is recorded on the agent's finish, before the first issue closes. */
  onRecorded?: (() => Promise<void>) | undefined;
  /** Called with the roster's outcome before the claims are released, so it outlives them. */
  onRosterClosed?: ((result: FinishReleaseBatchResult) => Promise<void>) | undefined;
  /**
   * Run inside each closing write's own transaction, before it writes; throws to stop the close
   * where it stands. It holds the run row, so a takeover waits until that write has committed.
   */
  fence?: ((tx: Tx) => Promise<void>) | undefined;
  /**
   * Called with the outcome before the run goes terminal. The run's close cascade ends the
   * release job's own session, so anything that must be written about this finish is written here.
   */
  onClosed?: ((result: FinishReleaseBatchResult) => Promise<void>) | undefined;
}

type ReleaseRunRow = {
  projectId: string;
  metadata: unknown;
  status: PipelineRunStatus;
  releaseVersion: string | null;
};

/** The run a finish is about, or `undefined` when there is no row under that id. */
export async function readReleaseRun(runId: string): Promise<ReleaseRunRow | undefined> {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      metadata: pipelineRuns.metadata,
      status: pipelineRuns.status,
      releaseVersion: pipelineRuns.releaseVersion,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return run;
}

/** Every refusal a finish can decide from the database alone. Nothing here makes an outbound request. */
export async function assertFinishable(runId: string, run: ReleaseRunRow): Promise<void> {
  if (batchAborted(run)) throw await abortedError(runId);
  // A release closes its roster claiming a ship; without a version nothing can name WHICH release
  // carried these issues, so it is refused by name. `createReleaseBatch` cuts the number in the
  // transaction that inserts the row, so a row reaching here without one was not opened by it.
  if (!run.releaseVersion) {
    throw refuseRelease(
      'RELEASE_VERSION_MISSING',
      `Release run ${runId} carries no version on its row, so it has no identity and nothing afterwards could name which release carried these issues. A release is given its version at the instant it is cut, so a run without one was never cut as a release. Abort this run and cut a new release.`,
    );
  }
}

/**
 * The agent's finish is the release's record under the version the batch was cut with (owner
 * 2026-11-01): the run is stamped `recorded` before any issue closes. Nothing is read to prove it.
 */
async function recordBeforeClose(
  runId: string,
  run: ReleaseRunRow,
  options: FinishReleaseBatchOptions,
): Promise<void> {
  await assertFinishable(runId, run);
  await options.onRecorded?.();
  await writeRunMetadata(runId, { merge: { verification: RECORDED_VERIFICATION }, touch: false });
}

export async function finishReleaseBatch(
  runId: string,
  actor: TransitionActor,
  options: FinishReleaseBatchOptions = {},
): Promise<FinishReleaseBatchResult> {
  const run = await readReleaseRun(runId);

  const claimed: ClaimedRow[] = await db
    .select({
      id: issues.id,
      status: issues.status,
      reopenCount: issues.reopenCount,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));

  if (run?.status === 'completed' && claimed.length === 0) {
    const done = { closed: [], failed: [] };
    await options.onClosed?.(done);
    return done;
  }

  const { fence } = options;
  if (run) await recordBeforeClose(runId, run, options);

  const { closed, failed } = await closeRoster(claimed, runId, actor, fence);

  await options.onRosterClosed?.({ closed, failed });

  // A release whose finish closed none of its roster did not ship it: the agent recorded it, but
  // nothing here was closed into the release, so it reads `failed` and carries no ship
  // stamp (ISS-811; agenfold's ISS-11 was the whole roster of seven releases, each stamped shipped
  // and each closing nothing). A release that closed any of its roster did ship, and what it could
  // not close is held below, so it is not cut again into the same refusal.
  const shipsNone = claimed.length > 0 && closed.length === 0;
  // what it could not close is the release's residue (`residue.ts`), closed into it by a later record
  await markResidue(
    runId,
    failed.map((f) => f.id),
  );

  // The ship, stamped on the release row itself. It is not read back off the run's status because
  // `cancelConcludedRun` flips a `completed` run to `cancelled`, and a release that shipped and was
  // aborted afterwards is still the one whose bytes are live. Stamped before the recovery below,
  // which reads it: a shipped run holds nothing, so an issue that did not close leaves the release
  // step unclaimed, where a person's cut can carry it.
  if (!shipsNone) {
    if (fence) {
      await db.transaction(async (tx) => {
        await fence(tx);
        await stampReleaseShipped(runId, tx);
      });
    } else {
      await stampReleaseShipped(runId);
    }
  }

  await recoverStrandedReleasing(runId, {
    reason: 'the release finished but this issue could not be closed',
    actorUserId: actor.type === 'user' ? actor.id : undefined,
    comment: true,
    recordedLive: shipsNone,
    fence,
  });
  await holdResidue(runId, run?.releaseVersion ?? null, failed);
  // a landing this release holds whose mark came after its cut, so its roster never named it, is
  // recorded as shipped in this release by its finish (ISS-888)
  if (!shipsNone) await claimMarkedLate(runId, actor);

  const result = { closed, failed };
  await options.onClosed?.(result);
  if (shipsNone) {
    await closeRunIfOneShot(runId, 'failed', {
      code: 'release_closed_none',
      detail: `none of the ${claimed.length} rostered issues would close: ${failed
        .map((f) => `${f.id} (${f.reason})`)
        .join('; ')}`,
    });
  } else {
    await closeRunIfOneShot(runId, 'completed');
  }

  return result;
}

/** What the recovery did to the roster, and what the abort did to the run row. `alreadyClosed` is
 *  every roster issue closed when the abort ran, claimed or not (`closedBeforeAbort`). */
interface AbortReleaseBatchResult extends RecoverStrandedReleasingResult {
  /** Issues back at the gate and held there for the person the blocker names (`RELEASE_ABORT_BLOCKED`). */
  heldForPerson: string[];
  /** Issues an earlier release already shipped, recorded there on this abort's word (ISS-888). */
  shippedInRecorded: string[];
  /** Issues an earlier shipped release may hold, held for their agent's shipped-in record (ISS-888). */
  shippedInOwed: string[];
  run: {
    status: PipelineRunStatus | null;
    wasAlreadyTerminal: boolean;
    cancelledFrom: PipelineRunStatus | null;
  };
}

/**
 * What an abort does with a roster whose run already promoted.
 *
 * `hold` is the default: the code is on production, and the roster stays held at
 * `awaiting_release` at its `release` step. `return-to-gate` is the operator's route to terminal for
 * a batch that promoted and cannot verify, putting the roster back where
 * `POST /release-records` closes it on the agent's record of the version it shipped, with an
 * account (ISS-1199, ISS-851).
 */
type PromotedRosterSettlement = 'hold' | 'return-to-gate';

interface AbortReleaseBatchOptions {
  promotedRoster?: PromotedRosterSettlement | undefined;
  blocker?: AbortBlocker | undefined;
  pushed?: boolean | undefined;
  /** What outside Forge carries this release's version (`carried.ts`); absent says nothing. */
  carried?: readonly ReleaseVersionCarrier[] | undefined;
  /** The earlier shipped release that already holds this roster, as the run read it with git. */
  shippedIn?: { version: string; evidence: string } | undefined;
}

export async function abortReleaseBatch(
  runId: string,
  reason: string,
  actorUserId: string,
  options: AbortReleaseBatchOptions = {},
): Promise<AbortReleaseBatchResult> {
  refuseContradiction(options.pushed, options.carried);
  // First, so a finish sees the abort before the recovery and the cancel below (abort-stamp.ts).
  // What it says left the box is written under the version lock a re-cut decides under.
  const stampId = await db.transaction(async (tx) => {
    await lockRunVersions(tx, runId);
    const id = await stampAbort(
      runId,
      {
        reason,
        by: actorUserId,
        holdPromotedRoster: options.promotedRoster !== 'return-to-gate',
        blocker: options.blocker,
        pushed: options.pushed,
      },
      tx,
    );
    if (options.carried) await recordCarried(runId, options.carried, actorUserId, tx);
    return id;
  });
  const recovery = await recoverStrandedReleasing(runId, {
    reason: `batch release aborted: ${reason}`,
    actorUserId,
    comment: true,
    settlePromotedRoster: options.promotedRoster === 'return-to-gate',
  });
  const held = recovery.promoted && options.promotedRoster !== 'return-to-gate';
  const roster = held ? 'held' : 'released';
  const alreadyClosed = await closedBeforeAbort(runId, recovery.alreadyClosed);
  await settleAbortStamp(runId, stampId, { roster, closed: alreadyClosed });
  // a roster an earlier release already shipped is the agent's shipped-in record, recorded here where
  // the run named that release, and never a person's hold (ISS-888)
  const shipped = held
    ? { recorded: [], heldForAgent: [] }
    : await settleShipped(runId, recovery.claimsCleared, reason, actorUserId, options.shippedIn);
  const settled = new Set([...shipped.recorded, ...shipped.heldForAgent]);
  const heldForPerson =
    options.blocker?.owes === 'human' && !held
      ? await holdForPerson(
          runId,
          recovery.claimsCleared.filter((id) => !settled.has(id)),
          reason,
          options.blocker,
        )
      : [];

  await closeRunIfOneShot(runId, 'cancelled');

  const after = await cancelConcludedRun(runId);

  return {
    ...recovery,
    heldForPerson,
    shippedInRecorded: shipped.recorded,
    shippedInOwed: shipped.heldForAgent,
    alreadyClosed,
    run: {
      status: after.cancelled ? 'cancelled' : after.was,
      wasAlreadyTerminal: after.cancelled,
      cancelledFrom: after.cancelled ? after.was : null,
    },
  };
}

async function settleShipped(
  runId: string,
  issueIds: readonly string[],
  reason: string,
  userId: string,
  shippedIn: AbortReleaseBatchOptions['shippedIn'],
): Promise<AbortShippedOutcome> {
  const [run] = await db
    .select({ projectId: pipelineRuns.projectId, version: pipelineRuns.releaseVersion })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run) return { recorded: [], heldForAgent: [] };
  return settleAbortedShipped({
    projectId: run.projectId,
    runId,
    version: run.version,
    reason,
    issueIds,
    shippedIn,
    userId,
  });
}

/**
 * The roster an abort put back at the gate, held there for the person its blocker names, so no
 * unattended cut opens the same batch on the same refusal (ISS-234: three cuts in six minutes, two
 * versions burned). Written after the recovery: the hold is guarded on the row waiting unclaimed.
 */
async function holdForPerson(
  runId: string,
  issueIds: readonly string[],
  reason: string,
  blocker: AbortBlocker,
): Promise<string[]> {
  const [run] = await db
    .select({ projectId: pipelineRuns.projectId, version: pipelineRuns.releaseVersion })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run || issueIds.length === 0) return [];
  const hold = abortBlockedHold({
    projectId: run.projectId,
    version: run.version,
    reason,
    waitingFor: blocker.waitingFor,
  });
  await writeReleaseHolds({
    projectId: run.projectId,
    issueIds,
    holdFor: () => hold,
    now: new Date(),
  });
  return [...(await heldFromUnattendedCut(issueIds))];
}
