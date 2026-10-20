import { and, eq, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { stampKernelTxn } from '../db/kernel-marker.js';
import { type IssueStatus, issues, type WaitingKind } from '../db/schema.js';
import { type KernelActor, recordKernelTransition } from '../lifecycle/transition.js';
import { withActorContext } from '../pipeline/outbox-session.js';
import { closeOpenRunForIssue, setCurrentStepForOpenIssueRun } from '../pipeline/runs.js';
import {
  canTransitionFree,
  DRAFT_EXIT_TARGETS,
  isReopenEntry,
  RETIRED_STATUS_REPLACEMENTS,
} from '../pipeline/state-machine.js';
import { settleOpenQuestions } from '../questions/issue-coupling.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { actorAgency, type DeviceLite, type TransitionActor } from './actor-agency.js';
import { archivedAmong, archiveRefusalForTransition } from './archive.js';
import { resolveAutonomousParkTarget, storedWaitingKind } from './autonomous-park.js';
import { describeRewrite, noOpSentence, type TransitionRewrite } from './close-substitution.js';
import {
  assertIssueNeverEnteredPipeline,
  draftExitRefusal,
  explainDraftRace,
} from './draft-entry.js';
import { expireBlocksEdgesOnDrop, type UnblockedDependent } from './drop-cascade.js';
import { recordDropUnblock } from './drop-unblock.js';
import { resolveDeclaredEntryCriteria } from './entry-criteria.js';
import type { EntryCriterionKey } from './entry-criteria-keys.js';
import { refuseUnshippedClose } from './merged-at.js';
import { mintParkQuestion } from './park-question.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';
import { postReleaseGateHoldComment, resolveAgentCloseTarget } from './release-gate-hold.js';
import { refuseUnrecordedClose } from './release-record-required.js';
import { holdReleaseTagClose } from './release-tag-close.js';
import { explainReleasingRace, releasingDoorRefusal } from './releasing-door.js';
import { ISSUE_TERMINAL_STATUSES, statusLabel } from './status-sets.js';
import { TransitionError, type TransitionErrorCode } from './transition-error.js';
import { checkTransitionEvidence } from './transition-evidence.js';
import {
  parkReasonFault,
  postLeaveComment,
  postTransitionReasonComment,
  reasonWaived,
  requiresAuthoredReason,
} from './transition-reason.js';
import { withholdTransitionText } from './transition-withhold.js';

export const TERMINAL_FOR_DISPATCH = new Set<IssueStatus>([
  'awaiting_release',
  'releasing',
  'closed',
  'dropped',
]);

export { TransitionError, type TransitionErrorCode };

/** Who is performing the transition. `id` feeds the outbox actor context (ISS-196 trigger
 *  attribution); the WS `actorId` is the user id, or the device owner for a device actor. */

export type TransitionIssueRow = {
  id: string;
  projectId: string;
  status: IssueStatus;
  reopenCount: number;
};

type TransitionTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ApplyStatusTransitionOptions {
  beforeStatusWrite?: (tx: TransitionTx) => Promise<void>;
  /** The release notes `beforeStatusWrite` stores, which the close is judged on. */
  releaseNotesWritten?: unknown;
  /**
   * Bypass `canTransitionFree`. In practice that guard forbids `draft` and the
   * retired rungs as a target and restricts `draft`'s own exits, so this flag
   * buys exactly three things: entering `draft` (nothing does), entering a
   * retired rung (only the staged job tables still name one), and moving a
   * `draft` issue to a status outside {open, closed, developed}.
   *
   * It is NOT a general safety override: NO_OP, stale-transition detection and
   * every content guard still run. The orchestrator is its caller.
   */
  skip?: boolean;
  /**
   * ISS-596 — operator/tooling unblock sentinel or human-supplied reason.
   * Carried as the `pipeline.reason` outbox session setting (so the
   * orchestrator can allow an `on_hold → *` transition from a non-user
   * actor without breaching the ISS-411 hard-stop) AND echoed on the WS
   * `issue.statusChanged` payload.
   */
  reason?: string | undefined;
  /**
   * Why the pipeline is being stopped, in the actor's own words. REQUIRED
   * entering `reopen`, `waiting`, `needs_info` or `on_hold`; posted as a comment before
   * the status write. A trusted writer's `skip` waives it for all but `on_hold`.
   */
  transitionReason?: string | undefined;
  /**
   * What would settle this park, in the agent's own words. When present, the
   * park mints a free-text question and the reason becomes its prompt.
   */
  needs?: string | undefined;
  /** Why the open questions died with the work; a terminal move with one open is refused without it. */
  voidQuestions?: string | undefined;
  /** Refuse OPEN_QUESTIONS if one is open once the row is locked — the answer resume's guard. */
  requireNoOpenQuestions?: boolean;
  /**
   * Which flavour of "a human is needed" this park is. REQUIRED entering
   * `waiting`.
   */
  waitingKind?: WaitingKind | undefined;
  /**
   * This move is a release path's own — a finish, an abort or recovery, a release record, the
   * releasing sweep — so it may write `closed` past the gate and may leave `releasing`.
   */
  viaReleasePath?: boolean;
  /** The release run this move enters `releasing` under; only `createReleaseBatch` names one, and the
   *  UPDATE claims the issue for it in the same statement, unclaimed rows and a running run only. */
  releaseRun?: string;
}

export interface StatusTransitionResult {
  id: string;
  status: IssueStatus;
  reopenCount: number;
  updatedAt: Date;
  terminal: boolean;
  /**
   * Dependents whose `blocks` edge this transition expired, collected before
   * the expiry ran. Non-empty only on a `dropped` transition. The caller hands
   * this to `triggerTerminalDispatch` — it cannot be re-derived, because every
   * dependent query filters expired edges out.
   */
  unblockedDependents: UnblockedDependent[];
  /** Where a rule stored another status than the one asked for, what it stored and why; else null. */
  rewritten: TransitionRewrite | null;
}

/** WS `issue.statusChanged` publish. The bus subscriber for `transition` deliberately does NOT
 *  broadcast it, so writers publish inline to avoid a double-emit on the single-issue path. */
export function publishIssueStatusChange(
  projectId: string,
  payload: {
    issueId: string;
    from: IssueStatus;
    to: IssueStatus;
    reopenCount: number;
    actorId: string;
    reason: string | null;
    at: Date;
  },
): void {
  roomManager.publish(projectRoom(projectId), {
    event: 'issue.statusChanged',
    data: payload,
  });
}

/**
 * THE issue state-machine writer. Every surface — REST `/transition`,
 * REST `PATCH /batch`, MCP `forge_issues`, orchestrator soft-skip,
 * reconciler, finalize-failure — routes through here so
 * guard semantics, the conditional UPDATE, the shipped-work rule on `closed`,
 * WS broadcast, pipeline-health refresh and run close cannot drift apart.
 *
 * Throws `TransitionError` (NO_OP / ILLEGAL_TRANSITION /
 * REOPEN_REASON_REQUIRED / STALE_TRANSITION / PLAN_REQUIRED /
 * CLOSE_REQUIRES_SHIPPED / CLOSE_REQUIRES_RELEASE_TAG / RELEASE_TAG_UNREAD); callers map it onto their own error surface.
 */
export async function transitionIssueStatus(
  issue: TransitionIssueRow,
  requestedStatus: IssueStatus,
  actor: TransitionActor,
  sent: ApplyStatusTransitionOptions = {},
): Promise<StatusTransitionResult> {
  const staged = await stageIssueTransition(issue, requestedStatus, actor, sent);
  return staged.publish();
}

/** A status write made; its effects wait for `publish`, run once the caller's transaction commits. */
export interface StagedTransition {
  publish(): Promise<StatusTransitionResult>;
}

/**
 * `transitionIssueStatus`, stopped after the write. With `executor` the write is a savepoint of the
 * caller's transaction, and a refusal of any one move rolls back every move the caller made in it;
 * the caller calls `publish` on each after that transaction commits, and never before.
 */
export async function stageIssueTransition(
  issue: TransitionIssueRow,
  requestedStatus: IssueStatus,
  actor: TransitionActor,
  sent: ApplyStatusTransitionOptions = {},
  executor?: TransitionTx,
): Promise<StagedTransition> {
  const fromStatus = issue.status;
  const [archived] = await archivedAmong(db, [issue.id]);
  if (archived) throw new TransitionError('ISSUE_ARCHIVED', archived.message, { from: fromStatus });
  if (fromStatus === requestedStatus) {
    const same = { projectId: issue.projectId, requested: requestedStatus };
    throw new TransitionError(
      'NO_OP',
      noOpSentence({ ...same, parked: requestedStatus, final: fromStatus }),
      {
        status: fromStatus,
      },
    );
  }
  const door = await releasingDoorRefusal({
    issueId: issue.id,
    projectId: issue.projectId,
    from: fromStatus,
    to: requestedStatus,
    releaseRun: sent.releaseRun,
    viaReleasePath: sent.viaReleasePath,
  });
  if (door) throw door;
  const options = await withholdTransitionText(issue.id, sent);

  if (!options.skip && !canTransitionFree(fromStatus, requestedStatus)) {
    const replacement = RETIRED_STATUS_REPLACEMENTS.get(requestedStatus);
    if (replacement) {
      throw new TransitionError(
        'ILLEGAL_TRANSITION',
        `${statusLabel(requestedStatus)} is retired: nothing dispatches at it, so an issue there waits until a person moves it. Use ${statusLabel(replacement)}, which took its place.`,
        { from: fromStatus, to: requestedStatus, replacedBy: replacement },
      );
    }
    if (requestedStatus === 'draft') {
      await assertIssueNeverEnteredPipeline(issue.id, fromStatus);
    } else {
      throw new TransitionError('ILLEGAL_TRANSITION', draftExitRefusal(requestedStatus), {
        from: fromStatus,
        to: requestedStatus,
        allowedFromDraft: [...DRAFT_EXIT_TARGETS],
      });
    }
  }

  if (options.waitingKind && requestedStatus !== 'waiting') {
    throw new TransitionError(
      'WAITING_KIND_NOT_APPLICABLE',
      `Only a Waiting park keeps \`waitingKind\`, and ${statusLabel(requestedStatus)} cannot hold it. Say what the issue waits for in \`reason\` instead, which is posted as a comment and kept.`,
      { from: fromStatus, to: requestedStatus, waitingKind: options.waitingKind },
    );
  }

  const parkFault = parkReasonFault(fromStatus, requestedStatus, options);
  if (parkFault) {
    throw new TransitionError(parkFault.code, parkFault.detail, {
      from: fromStatus,
      to: requestedStatus,
    });
  }

  const reopening = isReopenEntry(fromStatus, requestedStatus);

  const parkTarget = await resolveAutonomousParkTarget({
    projectId: issue.projectId,
    requested: requestedStatus,
    agency: actorAgency(actor),
  });
  const { status: toStatus, held } = await resolveAgentCloseTarget({
    projectId: issue.projectId,
    requested: parkTarget,
    agency: actorAgency(actor),
    viaReleasePath: options.viaReleasePath === true,
  });
  if (fromStatus === toStatus) {
    throw new TransitionError(
      'NO_OP',
      noOpSentence({
        projectId: issue.projectId,
        requested: requestedStatus,
        parked: parkTarget,
        final: toStatus,
      }),
      { status: fromStatus, requested: requestedStatus, substituted: toStatus },
    );
  }

  const unrecorded = await refuseUnrecordedClose(issue.id, toStatus, actor, options);
  if (unrecorded) {
    throw new TransitionError('RELEASE_RECORD_REQUIRED', unrecorded.detail, unrecorded.details);
  }

  // Asked before the transaction opens, which no repository read should hold; the landing it judged is held inside.
  const guarded = await holdReleaseTagClose(issue, toStatus, options);

  const declaredCriteria =
    options.skip === true
      ? []
      : await resolveDeclaredEntryCriteria(issue.projectId, requestedStatus);

  const txResult = await executeTransitionWrite({
    issue,
    fromStatus,
    requestedStatus,
    toStatus,
    actor,
    options: guarded,
    reopening,
    declaredCriteria,
    executor,
  });
  return {
    publish: () =>
      publishTransition(
        { issue, fromStatus, requestedStatus, parkTarget, toStatus, held, actor },
        {
          options,
          txResult,
        },
      ),
  };
}

async function publishTransition(
  move: {
    issue: TransitionIssueRow;
    fromStatus: IssueStatus;
    requestedStatus: IssueStatus;
    parkTarget: IssueStatus;
    toStatus: IssueStatus;
    held: boolean;
    actor: TransitionActor;
  },
  written: { options: ApplyStatusTransitionOptions; txResult: TransitionWriteResult },
): Promise<StatusTransitionResult> {
  const { issue, fromStatus, requestedStatus, parkTarget, toStatus, held, actor } = move;
  const { options, txResult } = written;
  const updated = txResult.row;

  publishIssueStatusChange(issue.projectId, {
    issueId: updated.id,
    from: fromStatus,
    to: toStatus,
    reopenCount: updated.reopenCount,
    actorId: actor.type === 'user' ? actor.id : actor.ownerId,
    reason: options.reason ?? null,
    at: updated.updatedAt,
  });

  if (held) {
    await postReleaseGateHoldComment(issue.id, actor.type === 'user' ? actor.id : actor.ownerId);
  }

  if (txResult && txResult.unblockedDependents.length > 0) {
    await recordDropUnblock(issue, txResult.unblockedDependents, actor);
  }

  await publishPipelineHealthChanged(issue.projectId, [updated.id]);

  await setCurrentStepForOpenIssueRun(issue.id, toStatus);
  const terminal = TERMINAL_FOR_DISPATCH.has(toStatus) || held;
  if (ISSUE_TERMINAL_STATUSES.includes(toStatus) || held) {
    await closeOpenRunForIssue(issue.id, 'completed');
  }

  return {
    id: updated.id,
    status: updated.status as IssueStatus,
    reopenCount: updated.reopenCount,
    updatedAt: updated.updatedAt,
    terminal,
    unblockedDependents: txResult?.unblockedDependents ?? [],
    rewritten: describeRewrite({
      requested: requestedStatus,
      parked: parkTarget,
      final: updated.status,
      sentKind: options.waitingKind ?? null,
      storedKind: updated.waitingKind ?? null,
    }),
  };
}

type TransitionWriteInput = {
  issue: TransitionIssueRow;
  fromStatus: IssueStatus;
  requestedStatus: IssueStatus;
  toStatus: IssueStatus;
  actor: TransitionActor;
  options: ApplyStatusTransitionOptions;
  reopening: boolean;
  declaredCriteria: readonly EntryCriterionKey[];
  /** The caller's transaction this write is a savepoint of; `db` where absent. */
  executor?: TransitionTx | undefined;
};

type TransitionWriteResult = {
  row: {
    id: string;
    status: IssueStatus;
    reopenCount: number;
    updatedAt: Date;
    waitingKind: WaitingKind | null;
  };
  unblockedDependents: UnblockedDependent[];
};

/**
 * ISS-1107 — the transition actor as `kernel_transitions` stores one. The two
 * vocabularies differ: `TransitionActor` has `device`, which
 * `kernelTransitionActorTypes` has not, and a device IS a runner box, so it
 * records under that type carrying its own id. `agency` goes through
 * `actorAgency` rather than a spread — `null` is an agent-driven user there and
 * `undefined` is a human.
 */
function kernelActorFor(actor: TransitionActor): KernelActor {
  if (actor.type === 'user') {
    return { type: 'user', id: actor.id, agency: actorAgency(actor) };
  }
  return { type: 'runner', id: actor.id };
}

async function executeTransitionWrite(input: TransitionWriteInput): Promise<TransitionWriteResult> {
  const { issue, fromStatus, requestedStatus, toStatus, actor, options, reopening } = input;
  const { declaredCriteria, executor } = input;
  const claim = options.releaseRun;
  // ISS-1421 — `releasing` is entered claimed by a running release run, in this one statement.
  const releaseGate = claim
    ? [
        sql`(${issues.releaseBatchRunId} is null or ${issues.releaseBatchRunId} = ${claim})`,
        sql`exists (select 1 from pipeline_runs rr where rr.id = ${claim} and rr.status = 'running')`,
      ]
    : [];
  const draftGate =
    toStatus === 'draft' && !options.skip
      ? [
          sql`not exists (select 1 from pipeline_runs pr where pr.issue_id = ${issue.id}) and not exists (select 1 from jobs j where j.issue_id = ${issue.id})`,
        ]
      : [];
  try {
    return await (executor ?? db).transaction(async (tx) => {
      // ISS-1107 — stamped before any write, so the trigger reads this transaction's marker
      // whichever statement moves the status.
      await stampKernelTxn(tx);
      const archiveRefusal = await archiveRefusalForTransition(tx, issue.id, toStatus);
      if (archiveRefusal)
        throw new TransitionError('ISSUE_ARCHIVED', archiveRefusal, { to: toStatus });
      await options.beforeStatusWrite?.(tx);
      if (
        requiresAuthoredReason(fromStatus, requestedStatus) &&
        !reasonWaived(requestedStatus, options.skip)
      ) {
        await postTransitionReasonComment(
          {
            issueId: issue.id,
            authorId: actor.type === 'user' ? actor.id : actor.ownerId,
            fromStatus,
            toStatus: requestedStatus,
            reason: options.transitionReason?.trim() ?? '',
            waitingKind: options.waitingKind ?? null,
          },
          tx,
        );
      }
      if (options.skip !== true)
        await postLeaveComment({ issue, fromStatus, toStatus, actor, options }, tx);
      if (fromStatus !== toStatus) await mintParkQuestion({ issue, toStatus, actor, options }, tx);
      const violation = await checkTransitionEvidence({
        issue: { id: issue.id, projectId: issue.projectId },
        toStatus: requestedStatus,
        agency: actorAgency(actor),
        skip: options.skip === true,
        declaredCriteria,
        executor: tx,
      });
      if (violation) throw new TransitionError(violation.code, violation.detail, violation.details);
      // Judged on the status the issue LANDS at, and asked BEFORE the UPDATE: a close diverted to
      // the release gate lands at `awaiting_release` and is no close, and a refusal after the
      // conditional UPDATE is indistinguishable from the lost race it reports as STALE_TRANSITION.
      const unshipped = await refuseUnshippedClose(tx, { issueId: issue.id, toStatus });
      if (unshipped)
        throw new TransitionError('CLOSE_REQUIRES_SHIPPED', unshipped.detail, unshipped.details);
      const by = actor.type === 'user' ? actor.id : actor.ownerId;
      const asked = await settleOpenQuestions(tx, { ...options, issueId: issue.id, toStatus, by });
      if (asked) throw new TransitionError(asked.code, asked.detail, asked.details);
      // cm:flow dispatch/transition — the status UPDATE commits and an AFTER UPDATE trigger enqueues the outbox row in this same transaction
      const result = await withActorContext(
        tx,
        { type: actor.type, id: actor.id },
        options.reason ?? null,
        async (t) => {
          const [row] = await t
            .update(issues)
            .set({
              status: toStatus,
              reopenCount: reopening ? sql`${issues.reopenCount} + 1` : issues.reopenCount,
              waitingKind: storedWaitingKind(requestedStatus, toStatus, options.waitingKind),
              ...(claim ? { releaseBatchRunId: claim } : {}),
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(issues.id, issue.id),
                eq(issues.status, fromStatus),
                ...draftGate,
                ...releaseGate,
              ),
            )
            .returning({
              id: issues.id,
              status: issues.status,
              reopenCount: issues.reopenCount,
              updatedAt: issues.updatedAt,
              waitingKind: issues.waitingKind,
            });
          if (!row) return null;
          await recordKernelTransition(t, [
            {
              entity: 'issue',
              entityId: row.id,
              fromStatus,
              toStatus,
              reason: options.transitionReason?.trim() || options.reason || null,
              actor: kernelActorFor(actor),
              source: 'issues',
            },
          ]);
          const unblockedDependents =
            toStatus === 'dropped'
              ? await expireBlocksEdgesOnDrop(t, issue.projectId, issue.id)
              : [];
          return { row, unblockedDependents };
        },
      );
      if (!result)
        throw new TransitionError('STALE_TRANSITION', 'Another move landed first. Retry.', {
          from: fromStatus,
          to: toStatus,
        });
      return result;
    });
  } catch (error) {
    if (error instanceof TransitionError && error.code === 'STALE_TRANSITION' && draftGate.length) {
      throw await explainDraftRace(issue.id, fromStatus, toStatus);
    }
    if (error instanceof TransitionError && error.code === 'STALE_TRANSITION' && claim) {
      throw await explainReleasingRace(issue.id, fromStatus, claim);
    }
    throw error;
  }
}

/** Device-actor wrapper for MCP tools and pipeline internals. Same semantics as
 *  `transitionIssueStatus`; failures surface as `TransitionError`, whose legacy `CODE: detail`
 *  message MCP tool handlers wrap uniformly. */
export async function applyStatusTransition(
  issue: TransitionIssueRow,
  toStatus: IssueStatus,
  device: DeviceLite,
  options: ApplyStatusTransitionOptions = {},
): Promise<StatusTransitionResult> {
  return transitionIssueStatus(issue, toStatus, { type: 'device', ...device }, options);
}
