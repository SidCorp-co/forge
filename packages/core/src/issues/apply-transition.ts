import { and, eq, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { stampKernelTxn } from '../db/kernel-marker.js';
import { comments, type IssueStatus, issues, type WaitingKind } from '../db/schema.js';
import type { WorkStep } from '../db/schema-issue-work-state.js';
import { type KernelActor, recordKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { withActorContext } from '../pipeline/outbox-session.js';
import { closeOpenRunForIssue, setCurrentStepForOpenIssueRun } from '../pipeline/runs.js';
import { isRecoveryEdge, PARK_STATUSES } from '../pipeline/state-machine.js';
import { settleOpenQuestions } from '../questions/issue-coupling.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { actorAgency, type DeviceLite, type TransitionActor } from './actor-agency.js';
import { archivedAmong, archiveRefusalForTransition } from './archive.js';
import { noOpSentence } from './close-substitution.js';
import { expireBlocksEdgesOnDrop, type UnblockedDependent } from './drop-cascade.js';
import { recordDropUnblock } from './drop-unblock.js';
import { heldRung, type LegacyRung, type LegacyTarget } from './legacy-status.js';
import { refuseUnshippedClose } from './merged-at.js';
import { mintParkQuestion } from './park-question.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';
import { resolveAgentCloseTarget } from './release-gate-hold.js';
import { refuseUnrecordedClose } from './release-record-required.js';
import { ISSUE_TERMINAL_STATUSES } from './status-sets.js';
import { legacyRungEvidenceFault } from './transition-evidence.js';
import { edgeFault, type GuardCode, guardFault, reasonFault } from './transition-guards.js';
import {
  postLeaveComment,
  postTransitionReasonComment,
  requiresAuthoredReason,
} from './transition-reason.js';
import {
  issueHolder,
  readWorkState,
  setLeftStatus,
  setLegacyStatus,
  setWorkStep,
} from './work-state.js';

export const TERMINAL_FOR_DISPATCH = new Set<IssueStatus>([
  'awaiting_release',
  'closed',
  'dropped',
]);

export type TransitionErrorCode =
  | GuardCode
  | 'NO_OP'
  | 'STALE_TRANSITION'
  | 'RELEASE_RECORD_REQUIRED'
  | 'CLOSE_REQUIRES_SHIPPED'
  | 'WAITING_KIND_NOT_APPLICABLE'
  | 'ISSUE_ARCHIVED'
  | 'OPEN_QUESTIONS';

/**
 * Typed transition failure. `message` keeps the legacy `CODE: detail` shape
 * the MCP surface exposes; REST callers map `code`/`detail`/`details` onto
 * HTTPException instead of parsing the string.
 */
export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    readonly detail: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${detail}`);
  }
}

export type TransitionIssueRow = {
  id: string;
  projectId: string;
  status: IssueStatus;
  reopenCount: number;
};

type TransitionTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * cm:hack a move named in forge-plugin 3.36.542's seventeen statuses (`legacy-status.ts`). `target`
 * is the retired name's mapping, or null where the name is one of the ten; `client17` is a caller
 * reading replies in the old words, for whom naming the status the row already holds while it
 * stands at a retired rung is a step forward, not a no-op. Exit: until forge-plugin moves to the
 * 10-status model (plugin-followups.md).
 */
export interface LegacyMove {
  named: string;
  target: (LegacyTarget & { named: string }) | null;
  client17: boolean;
}

export interface ApplyStatusTransitionOptions {
  beforeStatusWrite?: (tx: TransitionTx) => Promise<void>;
  /**
   * A kernel recovery move rather than a lifecycle move: a run that ended, or a wedge nothing holds,
   * handing an `in_progress` issue back (`state-machine.ts:RECOVERY_EDGES`). Refused while anything
   * still holds the issue. Every other guard runs.
   */
  recovery?: boolean;
  /** The run a recovery move hands the issue back from: its own hold is the one ending, not a holder. */
  recoveringRunId?: string;
  /**
   * ISS-596 — operator/tooling unblock sentinel or human-supplied reason.
   * Carried as the `pipeline.reason` outbox session setting AND echoed on the WS
   * `issue.statusChanged` payload.
   */
  reason?: string | undefined;
  /**
   * Why, in the actor's own words: the question at `needs_info`, the pause at `on_hold`, what was
   * wrong at `reopen`, why it is not work at `dropped`. Posted as a comment before the status write.
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
  /** What a `needs_info` park is stopped on. REQUIRED entering `needs_info`. */
  waitingKind?: WaitingKind | undefined;
  /**
   * This close is the release itself, so it may write `closed` past the gate.
   */
  viaReleasePath?: boolean;
  /** cm:hack see `LegacyMove`. */
  legacy?: LegacyMove | undefined;
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
  /** The step the run is at inside the status after this move, or null. */
  step: WorkStep | null;
  /** cm:hack the retired rung a 17-status caller wrote and reads back, or null. */
  legacyRung: LegacyRung | null;
  /** True where the move changed only the step inside the status (a 17-status rung). */
  stepOnly: boolean;
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

const authorOf = (actor: TransitionActor) => (actor.type === 'user' ? actor.id : actor.ownerId);

/**
 * The step a move leaves the run at. A retired rung names its own; a claim from the backlog starts
 * at triage, from the plan checkpoint or a reopen at build; a park keeps the step it paused, and
 * its return finds it there; every other status holds no step.
 */
function stepAfter(
  from: IssueStatus,
  to: IssueStatus,
  held: WorkStep | null,
  legacy: LegacyMove | undefined,
): WorkStep | null {
  if (legacy?.target && legacy.target.status === to) return legacy.target.step ?? held;
  if (PARK_STATUSES.includes(to)) return held;
  if (to === 'in_progress') {
    if (PARK_STATUSES.includes(from)) return held;
    return from === 'open' ? 'triage' : 'build';
  }
  return null;
}

/**
 * THE issue state-machine writer. Every surface — REST `/transition`,
 * REST `PATCH /batch`, MCP `forge_issues`, the reconciler, the release batch — routes through here so
 * the lifecycle's edges and guards (`transition-guards.ts`), the conditional UPDATE, the work state,
 * WS broadcast, pipeline-health refresh and run close cannot drift apart.
 *
 * Throws `TransitionError`; callers map it onto their own error surface.
 */
export async function transitionIssueStatus(
  issue: TransitionIssueRow,
  requestedStatus: IssueStatus,
  actor: TransitionActor,
  options: ApplyStatusTransitionOptions = {},
): Promise<StatusTransitionResult> {
  const fromStatus = issue.status;
  const [archived] = await archivedAmong(db, [issue.id]);
  if (archived) throw new TransitionError('ISSUE_ARCHIVED', archived.message, { from: fromStatus });
  const work = await readWorkState(db, issue.id);
  const leftStatus = (work?.leftStatus ?? null) as IssueStatus | null;
  const rungHeld = heldRung(fromStatus, work?.legacyStatus ?? null);

  if (fromStatus === requestedStatus) {
    const asked = options.legacy?.target?.rung ?? null;
    if (options.legacy?.client17 && asked !== rungHeld) {
      return moveStepOnly({ issue, actor, options, rung: asked, held: work?.step ?? null });
    }
    throw new TransitionError('NO_OP', `issue already in status ${requestedStatus}`, {
      status: fromStatus,
    });
  }

  const recovering = options.recovery === true && isRecoveryEdge(fromStatus, requestedStatus);
  if (!recovering) {
    const edge = edgeFault({ from: fromStatus, to: requestedStatus, leftStatus });
    if (edge) throw new TransitionError(edge.code, edge.detail, edge.details);
  }

  if (options.waitingKind && requestedStatus !== 'needs_info') {
    throw new TransitionError(
      'WAITING_KIND_NOT_APPLICABLE',
      `\`waitingKind\` is stored only for a \`needs_info\` park, and \`${requestedStatus}\` cannot hold it. Say what the issue is waiting for in \`reason\` instead — that is posted as a comment before the status flips and is kept.`,
      { from: fromStatus, to: requestedStatus, waitingKind: options.waitingKind },
    );
  }

  const reasonMissing = reasonFault({
    from: fromStatus,
    to: requestedStatus,
    agency: actorAgency(actor),
    transitionReason: options.transitionReason,
    waitingKind: options.waitingKind,
  });
  if (reasonMissing) {
    throw new TransitionError(reasonMissing.code, reasonMissing.detail, reasonMissing.details);
  }

  const { status: toStatus, held } = await resolveAgentCloseTarget({
    projectId: issue.projectId,
    requested: requestedStatus,
    agency: actorAgency(actor),
    viaReleasePath: options.viaReleasePath === true,
  });
  if (fromStatus === toStatus) {
    throw new TransitionError(
      'NO_OP',
      noOpSentence({ projectId: issue.projectId, requested: requestedStatus, final: toStatus }),
      { status: fromStatus, requested: requestedStatus, substituted: toStatus },
    );
  }

  const unrecorded = await refuseUnrecordedClose(issue.id, toStatus, actor, options);
  if (unrecorded) {
    throw new TransitionError('RELEASE_RECORD_REQUIRED', unrecorded.detail, unrecorded.details);
  }

  const step = stepAfter(fromStatus, toStatus, work?.step ?? null, options.legacy);
  const rungAfter = options.legacy?.client17 ? (options.legacy.target?.rung ?? null) : null;
  const txResult = await executeTransitionWrite({
    issue,
    fromStatus,
    requestedStatus,
    toStatus,
    actor,
    options,
    recovering,
    step,
    rungAfter,
    leftStatus,
  });
  const updated = txResult.row;

  publishIssueStatusChange(issue.projectId, {
    issueId: updated.id,
    from: fromStatus,
    to: toStatus,
    reopenCount: updated.reopenCount,
    actorId: authorOf(actor),
    reason: options.reason ?? null,
    at: updated.updatedAt,
  });

  if (held) {
    try {
      await db.insert(comments).values({
        issueId: issue.id,
        authorId: authorOf(actor),
        body: `Held at the release gate — merged, not shipped. Every \`blocks\`-dependent can dispatch now, because a dependent is held by this issue's STATUS and \`awaiting_release\` is one that releases it; nothing here writes \`merged_at\`. The issue closes when a release ships it, and that close is refused until the shipped-work claim is on the row — \`forge_issues\` \`mark_merged\` naming where it landed.`,
        parentId: null,
      });
    } catch (err) {
      logger.warn(
        { err, issueId: issue.id },
        'transition: release-gate hold comment failed (transition already committed)',
      );
    }
  }

  if (txResult.unblockedDependents.length > 0) {
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
    unblockedDependents: txResult.unblockedDependents,
    step,
    legacyRung: PARK_STATUSES.includes(toStatus) ? null : rungAfter,
    stepOnly: false,
  };
}

/**
 * A 17-status caller moving between rungs one stored status holds (`LegacyMove`) — `confirmed` →
 * `in_progress` → `developed` → `testing` are all `in_progress` now. The status does not move, so
 * nothing is written to `kernel_transitions`; the step and the rung move on the work state. The
 * evidence rule the old `developed`/`testing` carried still holds an agent to it.
 */
async function moveStepOnly(args: {
  issue: TransitionIssueRow;
  actor: TransitionActor;
  options: ApplyStatusTransitionOptions;
  rung: LegacyRung | null;
  held: WorkStep | null;
}): Promise<StatusTransitionResult> {
  const { issue, actor, options, rung } = args;
  const step: WorkStep | null =
    options.legacy?.target?.step ?? (issue.status === 'in_progress' ? 'build' : args.held);
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from issues where id = ${issue.id} for update`);
    const fault = await legacyRungEvidenceFault({
      issue,
      rung,
      agency: actorAgency(actor),
      executor: tx,
    });
    if (fault) throw new TransitionError(fault.code, fault.detail, fault.details);
    await setWorkStep(tx, issue.id, step);
    await setLegacyStatus(tx, issue.id, rung);
    const [current] = await tx
      .update(issues)
      .set({ updatedAt: sql`now()` })
      .where(and(eq(issues.id, issue.id), eq(issues.status, issue.status)))
      .returning({ id: issues.id, reopenCount: issues.reopenCount, updatedAt: issues.updatedAt });
    if (!current) {
      throw new TransitionError('STALE_TRANSITION', 'issue status changed concurrently', {
        from: issue.status,
        to: issue.status,
      });
    }
    return current;
  });
  await publishPipelineHealthChanged(issue.projectId, [issue.id]);
  return {
    id: row.id,
    status: issue.status,
    reopenCount: row.reopenCount,
    updatedAt: row.updatedAt,
    terminal: false,
    unblockedDependents: [],
    step,
    legacyRung: rung,
    stepOnly: true,
  };
}

type TransitionWriteInput = {
  issue: TransitionIssueRow;
  fromStatus: IssueStatus;
  requestedStatus: IssueStatus;
  toStatus: IssueStatus;
  actor: TransitionActor;
  options: ApplyStatusTransitionOptions;
  recovering: boolean;
  step: WorkStep | null;
  rungAfter: LegacyRung | null;
  /** The status the park being left was entered from, or null (`issue_work_state.left_status`). */
  leftStatus: IssueStatus | null;
};

type TransitionWriteResult = {
  row: { id: string; status: IssueStatus; reopenCount: number; updatedAt: Date };
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

/** The work state a move leaves: the park's left status, the step, and the 17-status rung. */
async function writeWorkStateOfMove(tx: TransitionTx, input: TransitionWriteInput): Promise<void> {
  const { issue, fromStatus, toStatus, step, rungAfter } = input;
  const enteringPark = PARK_STATUSES.includes(toStatus);
  const leavingPark = PARK_STATUSES.includes(fromStatus);
  if (enteringPark && !leavingPark) await setLeftStatus(tx, issue.id, fromStatus);
  if (!enteringPark && leavingPark) await setLeftStatus(tx, issue.id, null);
  await setWorkStep(tx, issue.id, step);
  if (!enteringPark) await setLegacyStatus(tx, issue.id, rungAfter);
}

async function executeTransitionWrite(input: TransitionWriteInput): Promise<TransitionWriteResult> {
  const { issue, fromStatus, requestedStatus, toStatus, actor, options, recovering } = input;
  return db.transaction(async (tx) => {
    // ISS-1107 — stamped before any write, so the trigger reads this transaction's marker
    // whichever statement moves the status.
    await stampKernelTxn(tx);
    const archiveRefusal = await archiveRefusalForTransition(tx, issue.id, toStatus);
    if (archiveRefusal)
      throw new TransitionError('ISSUE_ARCHIVED', archiveRefusal, { to: toStatus });
    await options.beforeStatusWrite?.(tx);
    if (recovering) {
      const holder = await issueHolder(tx, issue, new Date(), options.recoveringRunId ?? null);
      if (holder) {
        throw new TransitionError(
          'ILLEGAL_TRANSITION',
          `a recovery move hands back an \`in_progress\` issue nothing holds, and ${holder} holds this one — it stays with its holder`,
          { from: fromStatus, to: toStatus, holder },
        );
      }
    }
    // cm:guard a guard that cannot be read refuses the move by throwing, never allows it: this runs
    // inside the transition's transaction, which a failed read has already aborted.
    const guard = await guardFault({
      issue: { id: issue.id, projectId: issue.projectId },
      from: fromStatus,
      to: toStatus,
      leftStatus: input.leftStatus,
      agency: actorAgency(actor),
      transitionReason: options.transitionReason,
      waitingKind: options.waitingKind,
      executor: tx,
    });
    if (guard) throw new TransitionError(guard.code, guard.detail, guard.details);
    if (requiresAuthoredReason(fromStatus, requestedStatus)) {
      await postTransitionReasonComment(
        {
          issueId: issue.id,
          authorId: authorOf(actor),
          fromStatus,
          toStatus: requestedStatus,
          reason: options.transitionReason?.trim() ?? '',
          waitingKind: options.waitingKind ?? null,
        },
        tx,
      );
    }
    await postLeaveComment({ issue, fromStatus, toStatus, actor, options }, tx);
    await mintParkQuestion({ issue, toStatus, actor, options }, tx);
    // Judged on the status the issue LANDS at, and asked BEFORE the UPDATE: a close diverted to
    // the release gate lands at `awaiting_release` and is no close, and a refusal after the
    // conditional UPDATE is indistinguishable from the lost race it reports as STALE_TRANSITION.
    const unshipped = await refuseUnshippedClose(tx, { issueId: issue.id, toStatus });
    if (unshipped)
      throw new TransitionError('CLOSE_REQUIRES_SHIPPED', unshipped.detail, unshipped.details);
    const by = authorOf(actor);
    const asked = await settleOpenQuestions(tx, { ...options, issueId: issue.id, toStatus, by });
    if (asked) throw new TransitionError(asked.code, asked.detail, asked.details);
    // cm:flow dispatch/transition — the status UPDATE commits and an AFTER UPDATE trigger enqueues the outbox row in this same transaction
    const result = await withActorContext(
      tx,
      { type: actor.type, id: actor.id, agency: actorAgency(actor) },
      options.reason ?? null,
      async (t) => {
        const [row] = await t
          .update(issues)
          .set({
            status: toStatus,
            reopenCount:
              toStatus === 'reopen' ? sql`${issues.reopenCount} + 1` : issues.reopenCount,
            waitingKind: toStatus === 'needs_info' ? (options.waitingKind ?? null) : null,
            updatedAt: sql`now()`,
          })
          .where(and(eq(issues.id, issue.id), eq(issues.status, fromStatus)))
          .returning({
            id: issues.id,
            status: issues.status,
            reopenCount: issues.reopenCount,
            updatedAt: issues.updatedAt,
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
        await writeWorkStateOfMove(t, input);
        const unblockedDependents =
          toStatus === 'dropped' ? await expireBlocksEdgesOnDrop(t, issue.projectId, issue.id) : [];
        return { row, unblockedDependents };
      },
    );
    if (!result)
      throw new TransitionError('STALE_TRANSITION', 'issue status changed concurrently', {
        from: fromStatus,
        to: toStatus,
      });
    return result;
  });
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
