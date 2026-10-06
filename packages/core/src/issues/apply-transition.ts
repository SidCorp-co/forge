import {
  ISSUE_DISPATCH_TERMINAL_STATUSES,
  ISSUE_MACHINE,
  type IssueTransitionRefusalCode,
  PARK_STATUSES,
} from '@forge/contracts/issue-machine';
import type { staleTransitionRefusal } from '@forge/contracts/state-machine';
import { eq, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { type IssueStatus, issues, type WaitingKind } from '../db/schema.js';
import type { WorkStep } from '../db/schema-issue-work-state.js';
import { lockXact } from '../lib/advisory-lock.js';
import { type Refusal, RefusalError } from '../lib/refusal.js';
import { type KernelActor, type KernelExecutor, transition } from '../lifecycle/index.js';
import { actorAgency, type DeviceLite, type TransitionActor } from './actor-agency.js';
import { archivedAmong, archiveRefusalForTransition } from './archive.js';
import { expireBlocksEdgesOnDrop, type UnblockedDependent } from './drop-cascade.js';
import { postDropUnblockNotices } from './drop-unblock.js';
import { mintParkQuestion, needsNotApplicable } from './park-question.js';
import { settleOpenQuestions } from './ports.js';
import { moveOf, recordMove } from './record-events/kernel-records.js';
import { refuseOffRecoveryEdge } from './recovery-move.js';
import { edgeFault, reasonFault } from './transition-faults.js';
import { type GuardCode, issueGuards, readIssueMoveFacts } from './transition-guards.js';
import {
  postLeaveComment,
  postTransitionReasonComment,
  requiresAuthoredReason,
} from './transition-reason.js';
import { readWorkState, setLeftStatus, setWorkStep } from './work-state.js';

const TERMINAL_FOR_DISPATCH = new Set<IssueStatus>(ISSUE_DISPATCH_TERMINAL_STATUSES);

const isStale = (r: Refusal): r is ReturnType<typeof staleTransitionRefusal> =>
  r.code === 'STALE_TRANSITION';

/**
 * A refused move, under the guard's own code and declared status, its structured facts
 * (`openQuestionIds`, `requires`, …) on the refusal row. Both doors answer it in the envelope.
 */
export function transitionRefused(
  code: IssueTransitionRefusalCode,
  detail: string,
  details: Record<string, unknown> = {},
): RefusalError {
  return new RefusalError([{ ...details, code, path: '', detail }], code);
}

export type TransitionIssueRow = {
  id: string;
  projectId: string;
  status: IssueStatus;
  reopenCount: number;
};

type TransitionTx = Parameters<Parameters<Db['transaction']>[0]>[0];

interface ApplyStatusTransitionOptions {
  beforeStatusWrite?: (tx: TransitionTx) => Promise<void>;
  /**
   * A kernel recovery move rather than a lifecycle move: a run that ended, or a wedge nothing holds,
   * handing an `in_progress` issue back (the issue machine's recovery edges). Refused while anything
   * still holds the issue. Every other guard runs.
   */
  recovery?: boolean;
  /** The run a recovery move hands the issue back from: its own hold is the one ending, not a holder. */
  recoveringRunId?: string;
  /**
   * ISS-596 — operator/tooling unblock sentinel or human-supplied reason, recorded on the move and
   * carried by its outbox event.
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
  /**
   * The workflow design revision this park waits on. Its approver's decision answers the question
   * the park mints, which moves the issue on as an answer does (ISS-254).
   */
  awaitsDesign?: { workflowId: string; revision: number } | undefined;
  /** Why the open questions died with the work; a terminal move with one open is refused without it. */
  voidQuestions?: string | undefined;
  /** Refuse OPEN_QUESTIONS if one is open once the row is locked — the answer resume's guard. */
  requireNoOpenQuestions?: boolean;
  /** What a `needs_info` park is stopped on. REQUIRED entering `needs_info`. */
  waitingKind?: WaitingKind | undefined;
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
   * this to `publishUnblockCascade` — it cannot be re-derived, because every
   * dependent query filters expired edges out.
   */
  unblockedDependents: UnblockedDependent[];
  /** The step the run is at inside the status after this move, or null. */
  step: WorkStep | null;
  /** True where the move passed the verdict gate because the project does not require verdicts. */
  verdictsWaived?: true;
}

const authorOf = (actor: TransitionActor) => (actor.type === 'user' ? actor.id : actor.ownerId);

/**
 * The step a move leaves the run at. A claim from the backlog starts
 * at triage, from the plan checkpoint or a reopen at build; a park keeps the step it paused, and
 * its return finds it there; every other status holds no step.
 */
function stepAfter(from: IssueStatus, to: IssueStatus, held: WorkStep | null): WorkStep | null {
  if (PARK_STATUSES.includes(to)) return held;
  if (to === 'in_progress') {
    if (PARK_STATUSES.includes(from)) return held;
    return from === 'open' ? 'triage' : 'build';
  }
  return null;
}

/**
 * THE issue state-machine writer. Every surface — REST `/transition`, the reconciler, the release batch — routes through here so
 * the lifecycle's edges and guards (`transition-guards.ts`), the conditional UPDATE, the work state,
 * pipeline-health refresh and run close cannot drift apart. The broadcast is a consumer of the
 * move's outbox event.
 *
 * Throws `transitionRefused`'s refusal.
 */
export async function transitionIssueStatus(
  issue: TransitionIssueRow,
  toStatus: IssueStatus,
  actor: TransitionActor,
  options: ApplyStatusTransitionOptions = {},
): Promise<StatusTransitionResult> {
  const fromStatus = issue.status;
  const [archived] = await archivedAmong(db, [issue.id]);
  if (archived) throw transitionRefused('ISSUE_ARCHIVED', archived.message, { from: fromStatus });
  const work = await readWorkState(db, issue.id);
  const leftStatus = (work?.leftStatus ?? null) as IssueStatus | null;

  if (fromStatus === toStatus) {
    throw transitionRefused('NO_OP', `issue already in status ${toStatus}`, {
      status: fromStatus,
    });
  }

  if (options.recovery === true) refuseOffRecoveryEdge(fromStatus, toStatus);
  const recovering = options.recovery === true;
  if (!recovering) {
    const edge = edgeFault({ from: fromStatus, to: toStatus, leftStatus });
    if (edge) throw transitionRefused(edge.code, edge.detail, edge.details);
  }

  if (options.waitingKind && toStatus !== 'needs_info') {
    throw transitionRefused(
      'WAITING_KIND_NOT_APPLICABLE',
      `\`waitingKind\` is stored only for a \`needs_info\` park, and \`${toStatus}\` cannot hold it. Say what the issue is waiting for in \`reason\` instead — that is posted as a comment before the status flips and is kept.`,
      { from: fromStatus, to: toStatus, waitingKind: options.waitingKind },
    );
  }

  const needsRefused = needsNotApplicable({ issue, toStatus, actor, options });
  if (needsRefused) {
    throw transitionRefused('NEEDS_NOT_APPLICABLE', needsRefused, {
      from: fromStatus,
      to: toStatus,
    });
  }

  const reasonMissing = reasonFault({
    from: fromStatus,
    to: toStatus,
    agency: actorAgency(actor),
    transitionReason: options.transitionReason,
    waitingKind: options.waitingKind,
  });
  if (reasonMissing) {
    throw transitionRefused(reasonMissing.code, reasonMissing.detail, reasonMissing.details);
  }

  const step = stepAfter(fromStatus, toStatus, work?.step ?? null);
  const txResult = await executeTransitionWrite({
    issue,
    fromStatus,
    toStatus,
    actor,
    options,
    recovering,
    step,
    leftStatus,
  });
  const updated = txResult.row;

  const terminal = TERMINAL_FOR_DISPATCH.has(toStatus);

  return {
    id: updated.id,
    status: updated.status as IssueStatus,
    reopenCount: updated.reopenCount,
    updatedAt: updated.updatedAt,
    terminal,
    unblockedDependents: txResult.unblockedDependents,
    step,
    ...(txResult.verdictsWaived ? { verdictsWaived: true as const } : {}),
  };
}

export type TransitionWriteInput = {
  issue: TransitionIssueRow;
  fromStatus: IssueStatus;
  toStatus: IssueStatus;
  actor: TransitionActor;
  options: ApplyStatusTransitionOptions;
  recovering: boolean;
  step: WorkStep | null;
  /** The status the park being left was entered from, or null (`issue_work_state.left_status`). */
  leftStatus: IssueStatus | null;
};

type TransitionWriteResult = {
  row: { id: string; status: IssueStatus; reopenCount: number; updatedAt: Date };
  unblockedDependents: UnblockedDependent[];
  verdictsWaived: boolean;
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

/** The work state a move leaves: the park's left status and the step. */
async function writeWorkStateOfMove(tx: TransitionTx, input: TransitionWriteInput): Promise<void> {
  const { issue, fromStatus, toStatus, step } = input;
  const enteringPark = PARK_STATUSES.includes(toStatus);
  const leavingPark = PARK_STATUSES.includes(fromStatus);
  if (enteringPark && !leavingPark) await setLeftStatus(tx, issue.id, fromStatus);
  if (!enteringPark && leavingPark) await setLeftStatus(tx, issue.id, null);
  await setWorkStep(tx, issue.id, step);
}

async function executeTransitionWrite(input: TransitionWriteInput): Promise<TransitionWriteResult> {
  const { issue, fromStatus, toStatus, actor, options, recovering } = input;
  const by = authorOf(actor);
  const waiver = { waived: false };
  let unblockedDependents: UnblockedDependent[] = [];
  const facts = await readIssueMoveFacts({
    issue,
    actorUserId: by,
    actorDeviceId: actor.type === 'device' ? actor.id : null,
    to: toStatus,
  });
  const write = (exec: KernelExecutor) =>
    transition(exec, ISSUE_MACHINE, {
      to: toStatus,
      where: eq(issues.id, issue.id),
      expect: fromStatus,
      recovery: recovering,
      set: {
        reopenCount: toStatus === 'reopen' ? sql`${issues.reopenCount} + 1` : issues.reopenCount,
        waitingKind: toStatus === 'needs_info' ? (options.waitingKind ?? null) : null,
        updatedAt: sql`now()`,
      } as never,
      returning: ['id', 'status', 'reopenCount', 'updatedAt'],
      reason: options.transitionReason?.trim() || options.reason || null,
      actor: kernelActorFor(actor),
      source: 'issues',
      guards: issueGuards({
        issue: { id: issue.id, projectId: issue.projectId },
        leftStatus: input.leftStatus,
        agency: actorAgency(actor),
        actorUserId: by,
        facts,
        transitionReason: options.transitionReason,
        waitingKind: options.waitingKind,
        recoveringRunId: options.recoveringRunId,
        onVerdictsWaived: () => {
          waiver.waived = true;
        },
      }),
      beforeWrite: async (tx) => {
        const archiveRefusal = await archiveRefusalForTransition(tx, issue.id, toStatus);
        if (archiveRefusal) {
          throw transitionRefused('ISSUE_ARCHIVED', archiveRefusal, { to: toStatus });
        }
        await options.beforeStatusWrite?.(tx);
        if (requiresAuthoredReason(fromStatus, toStatus)) {
          await postTransitionReasonComment(
            {
              issueId: issue.id,
              authorId: by,
              fromStatus,
              toStatus,
              reason: options.transitionReason?.trim() ?? '',
              waitingKind: options.waitingKind ?? null,
            },
            tx,
          );
        }
        await postLeaveComment({ issue, fromStatus, toStatus, actor, options }, tx);
        await mintParkQuestion({ issue, toStatus, actor, options }, tx);
        const asked = await settleOpenQuestions(tx, {
          ...options,
          issueId: issue.id,
          toStatus,
          by,
          actor: kernelActorFor(actor),
        });
        if (asked) throw transitionRefused(asked.code, asked.detail, asked.details);
      },
      afterWrite: async (tx, rows) => {
        const row = rows[0];
        if (!row) return;
        await recordMove(tx, moveOf(input, row.reopenCount, waiver.waived));
        await writeWorkStateOfMove(tx, input);
        if (toStatus === 'dropped') {
          unblockedDependents = await expireBlocksEdgesOnDrop(tx, issue.projectId, issue.id);
          await postDropUnblockNotices(tx, issue, unblockedDependents, actor);
        }
      },
    });
  // a park waiting on a design revision takes the project's workflow lock before the issue row, the
  // order a decision or a superseding write takes them in, so the two cannot deadlock (ISS-254)
  const moved = options.awaitsDesign
    ? await db.transaction(async (tx) => {
        await lockXact(tx, 'workflows', issue.projectId);
        return write(tx);
      })
    : await write(db);
  const lead: Refusal | undefined = moved.refusals[0];
  if (lead && isStale(lead)) {
    throw transitionRefused('STALE_TRANSITION', lead.detail, {
      from: fromStatus,
      to: toStatus,
      expected: lead.expected,
      actual: lead.actual,
    });
  }
  const refused = lead as
    | (Refusal & { code: GuardCode; details?: Record<string, unknown> })
    | undefined;
  if (refused) throw transitionRefused(refused.code, refused.detail, refused.details ?? {});
  const [row] = moved.rows;
  if (!row) {
    throw transitionRefused(
      'STALE_TRANSITION',
      `the issue was expected at \`${fromStatus}\` for the move to \`${toStatus}\`, and it was deleted first`,
      { from: fromStatus, to: toStatus, expected: fromStatus, actual: null },
    );
  }
  return {
    row: { ...row, status: row.status as IssueStatus },
    unblockedDependents,
    verdictsWaived: waiver.waived,
  };
}

/** Device-actor wrapper for MCP tools and pipeline internals. Same semantics as
 *  `transitionIssueStatus`, refusals included. */
export async function applyStatusTransition(
  issue: TransitionIssueRow,
  toStatus: IssueStatus,
  device: DeviceLite,
  options: ApplyStatusTransitionOptions = {},
): Promise<StatusTransitionResult> {
  return transitionIssueStatus(issue, toStatus, { type: 'device', ...device }, options);
}
