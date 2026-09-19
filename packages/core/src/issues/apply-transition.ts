import { and, count, eq, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import {
  comments,
  type IssueStatus,
  issues,
  jobs,
  pipelineRuns,
  type WaitingKind,
} from '../db/schema.js';
import { logger } from '../logger.js';
import { withActorContext } from '../pipeline/outbox-session.js';
import { closeOpenRunForIssue, setCurrentStepForOpenIssueRun } from '../pipeline/runs.js';
import { canTransitionFree, DRAFT_EXIT_TARGETS, isReopenEntry } from '../pipeline/state-machine.js';
import { collectWorkEvidence, hasCodeEvidence } from '../pipeline/work-evidence.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { actorAgency, type DeviceLite, type TransitionActor } from './actor-agency.js';
import { resolveAutonomousParkTarget } from './autonomous-park.js';
import { expireBlocksEdgesOnDrop, type UnblockedDependent } from './drop-cascade.js';
import { recordDropUnblock } from './drop-unblock.js';
import { resolveDeclaredEntryCriteria } from './entry-criteria.js';
import type { EntryCriterionKey } from './entry-criteria-keys.js';
import { markMergedOnClose } from './merged-at.js';
import { mintParkQuestion } from './park-question.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';
import { resolveAgentCloseTarget } from './release-gate-hold.js';
import { refuseUnrecordedClose } from './release-record-required.js';
import { checkTransitionEvidence } from './transition-evidence.js';
import {
  parkReasonFault,
  postTransitionReasonComment,
  requiresAuthoredReason,
} from './transition-reason.js';

export const TERMINAL_FOR_DISPATCH = new Set<IssueStatus>([
  'awaiting_release',
  'releasing',
  'closed',
  'dropped',
]);

export const RUN_CLOSING_STATUSES = new Set<IssueStatus>(['closed', 'dropped']);

/**
 * Who is performing the transition. `id` feeds the outbox actor context
 * (ISS-196 trigger attribution); the WS `actorId` is the user id for user
 * actors and the device owner for device actors.
 */

export type TransitionErrorCode =
  | 'NO_OP'
  | 'ILLEGAL_TRANSITION'
  | 'TRANSITION_REASON_REQUIRED'
  | 'WAITING_KIND_REQUIRED'
  | 'STALE_TRANSITION'
  | 'NO_WORK_EVIDENCE'
  | 'RELEASE_RECORD_REQUIRED'
  | 'ENTRY_CRITERIA_UNMET'
  | 'WAITING_KIND_NOT_APPLICABLE';

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

export interface ApplyStatusTransitionOptions {
  beforeStatusWrite?: (tx: TransitionTx) => Promise<void>;
  /**
   * Bypass `canTransitionFree`. In practice that guard only forbids `draft`
   * as a target and restricts `draft`'s own exits, so this flag buys exactly
   * two things: entering `draft` (nothing does) and moving a `draft` issue to
   * a status outside {open, closed, developed}.
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
   * entering `reopen`, `waiting` or `needs_info`; posted as a comment before
   * the status write.
   */
  transitionReason?: string | undefined;
  /**
   * What would settle this park, in the agent's own words. When present, the
   * park mints a free-text question and the reason becomes its prompt.
   */
  needs?: string | undefined;
  /**
   * Which flavour of "a human is needed" this park is. REQUIRED entering
   * `waiting`.
   */
  waitingKind?: WaitingKind | undefined;
  /**
   * This close is the release itself, so it may write `closed` past the gate.
   */
  viaReleasePath?: boolean;
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
}

/**
 * WS `issue.statusChanged` publish. The bus subscriber for `transition`
 * intentionally does NOT broadcast `issue.statusChanged` (see
 * `ws/broadcast-subscribers.ts:38`); writers must publish inline to avoid
 * double-emit on the single-issue path.
 */
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
 * ISS-787 — `draft` is the safe entry status you only get by remembering to
 * ask for it, and `open` (the default) auto-triages and spawns a pipeline run.
 * Three agents on three projects made that mistake, and `ILLEGAL_TRANSITION`
 * left them no way back: one parked at `on_hold`, another left the run going.
 *
 * So `draft` is reachable, but only while the mistake is still only a mistake:
 * nothing has run. A run or a job means work exists, and demoting to `draft`
 * would make the status claim the issue was never started.
 */
/** `null` when the counts could not be read — callers must treat that as "refuse". */
async function countRunsAndJobs(
  issueId: string,
): Promise<{ runCount: number; jobCount: number } | null> {
  try {
    const [[runRow], [jobRow]] = await Promise.all([
      db
        .select({ n: count() })
        .from(pipelineRuns)
        .where(eq(pipelineRuns.issueId, issueId))
        .limit(1),
      db.select({ n: count() }).from(jobs).where(eq(jobs.issueId, issueId)).limit(1),
    ]);
    return { runCount: Number(runRow?.n ?? 0), jobCount: Number(jobRow?.n ?? 0) };
  } catch (err) {
    logger.warn({ err, issueId }, 'draft-exemption check failed; refusing the transition');
    return null;
  }
}

async function assertIssueNeverEnteredPipeline(
  issueId: string,
  fromStatus: IssueStatus,
): Promise<void> {
  const refuse = (detail: string, details: Record<string, unknown>): never => {
    throw new TransitionError('ILLEGAL_TRANSITION', detail, {
      from: fromStatus,
      to: 'draft',
      ...details,
    });
  };

  const counts = await countRunsAndJobs(issueId);
  if (!counts) {
    return refuse(
      '`draft` is reachable only while the issue has never entered the pipeline, and that could not be checked just now. Retry, or use `on_hold` to pause active work.',
      { checkFailed: true },
    );
  }

  const { runCount, jobCount } = counts;
  if (runCount === 0 && jobCount === 0) return;
  return refuse(
    `\`draft\` is reachable only while the issue has never entered the pipeline; this one has ${runCount} pipeline run(s) and ${jobCount} job(s). Use \`on_hold\` to pause active work, or \`dropped\` to abandon it.`,
    { runCount, jobCount },
  );
}

/**
 * Two conditions share the `draft` UPDATE's WHERE — the status must still be
 * `fromStatus`, and the never-ran counts must still be zero — so a zero-row
 * result alone does not say which one bit. Re-read both and name the one that
 * did, rather than reporting a lost status race as a run appearing.
 */
async function explainDraftRace(
  issueId: string,
  fromStatus: IssueStatus,
  toStatus: IssueStatus,
): Promise<TransitionError> {
  const details = { from: fromStatus, to: toStatus, raced: true };
  const [[row], counts] = await Promise.all([
    db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).limit(1),
    countRunsAndJobs(issueId),
  ]);
  if (row && row.status !== fromStatus) {
    return new TransitionError(
      'STALE_TRANSITION',
      `issue status changed concurrently — it left \`${fromStatus}\` for \`${row.status}\` while this transition was being applied`,
      { ...details, observedStatus: row.status },
    );
  }
  if (counts && (counts.runCount > 0 || counts.jobCount > 0)) {
    return new TransitionError(
      'ILLEGAL_TRANSITION',
      `\`draft\` is reachable only while the issue has never entered the pipeline, and it acquired ${counts.runCount} pipeline run(s) and ${counts.jobCount} job(s) while this transition was being applied. Use \`on_hold\` to pause active work.`,
      { ...details, runCount: counts.runCount, jobCount: counts.jobCount },
    );
  }
  return new TransitionError(
    'ILLEGAL_TRANSITION',
    `the \`draft\` transition from \`${fromStatus}\` did not apply, and re-reading found neither a status change nor a pipeline run/job to attribute it to. Retry; if it refuses again, use \`on_hold\` to pause active work.`,
    { ...details, attributable: false },
  );
}

/**
 * THE issue state-machine writer. Every surface — REST `/transition`,
 * REST `PATCH /batch`, MCP `forge_issues`, orchestrator soft-skip,
 * reconciler, finalize-failure — routes through here so
 * guard semantics, the conditional UPDATE, `merged_at` stamping, WS
 * broadcast, pipeline-health refresh and run close cannot drift apart.
 *
 * Throws `TransitionError` (NO_OP / ILLEGAL_TRANSITION /
 * REOPEN_REASON_REQUIRED / STALE_TRANSITION / PLAN_REQUIRED); callers map it
 * onto their own error surface.
 */
export async function transitionIssueStatus(
  issue: TransitionIssueRow,
  requestedStatus: IssueStatus,
  actor: TransitionActor,
  options: ApplyStatusTransitionOptions = {},
): Promise<StatusTransitionResult> {
  const fromStatus = issue.status;
  if (fromStatus === requestedStatus) {
    throw new TransitionError('NO_OP', `issue already in status ${requestedStatus}`, {
      status: fromStatus,
    });
  }

  if (!options.skip && !canTransitionFree(fromStatus, requestedStatus)) {
    if (requestedStatus === 'draft') {
      await assertIssueNeverEnteredPipeline(issue.id, fromStatus);
    } else {
      throw new TransitionError(
        'ILLEGAL_TRANSITION',
        `a \`draft\` issue may only move to ${DRAFT_EXIT_TARGETS.map((s) => `\`${s}\``).join(', ')}. \`${requestedStatus}\` is a legal target from every other status, but not from \`draft\` — promote it to \`open\` first, or use \`dropped\` to discard it.`,
        { from: fromStatus, to: requestedStatus, allowedFromDraft: [...DRAFT_EXIT_TARGETS] },
      );
    }
  }

  if (options.waitingKind && requestedStatus !== 'waiting') {
    throw new TransitionError(
      'WAITING_KIND_NOT_APPLICABLE',
      `\`waitingKind\` is stored only for a \`waiting\` park, and \`${requestedStatus}\` cannot hold it. Say what the issue is waiting for in \`reason\` instead — that is posted as a comment before the status flips and is kept.`,
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
    throw new TransitionError('NO_OP', `issue already in status ${toStatus}`, {
      status: fromStatus,
      requested: requestedStatus,
    });
  }

  const unrecorded = await refuseUnrecordedClose(issue.id, toStatus, actor, options);
  if (unrecorded) {
    throw new TransitionError('RELEASE_RECORD_REQUIRED', unrecorded.detail, unrecorded.details);
  }

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
    options,
    reopening,
    declaredCriteria,
  });
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
    try {
      await db.insert(comments).values({
        issueId: issue.id,
        authorId: actor.type === 'user' ? actor.id : actor.ownerId,
        body: `Held at the release gate — merged, not shipped. \`merged_at\` is stamped, so every \`blocks\`-dependent can dispatch now; the issue closes when a release ships it.`,
        parentId: null,
      });
    } catch (err) {
      logger.warn(
        { err, issueId: issue.id },
        'transition: release-gate hold comment failed (transition already committed)',
      );
    }
  }

  if (txResult?.stampedOnClose && !held) {
    try {
      const evidenceFound = await collectWorkEvidence(issue.id)
        .then(hasCodeEvidence)
        .catch(() => true);
      const evidenceNote = evidenceFound
        ? "If this issue was abandoned (its code never landed on the base branch), run `forge_issues` `unmark` to withdraw the shipped-work claim. That alone does NOT re-block the dependents: they are held by this issue's STATUS, and `closed` releases them whatever `merged_at` says (ISS-1100). Move this issue back off `closed` to hold them again."
        : "No branch, commit or code handoff is recorded for this issue — if its code never landed, run `forge_issues` `unmark` to withdraw the shipped-work claim. That alone does NOT re-block the dependents: they are held by this issue's STATUS, and `closed` releases them whatever `merged_at` says (ISS-1100). Move this issue back off `closed` to hold them again.";
      await db.insert(comments).values({
        issueId: issue.id,
        authorId: actor.type === 'user' ? actor.id : actor.ownerId,
        body: `merged_at auto-stamped on close — \`closed\` counts as done, so \`blocks\`-dependents can now dispatch. ${evidenceNote}`,
        parentId: null,
      });
    } catch (err) {
      logger.warn(
        { err, issueId: issue.id },
        'transition: close-stamp audit comment failed (transition already committed)',
      );
    }
  }

  if (txResult && txResult.unblockedDependents.length > 0) {
    await recordDropUnblock(issue, txResult.unblockedDependents, actor);
  }

  await publishPipelineHealthChanged(issue.projectId, [updated.id]);

  await setCurrentStepForOpenIssueRun(issue.id, toStatus);
  const terminal = TERMINAL_FOR_DISPATCH.has(toStatus) || held;
  if (RUN_CLOSING_STATUSES.has(toStatus) || held) {
    await closeOpenRunForIssue(issue.id, 'completed');
  }

  return {
    id: updated.id,
    status: updated.status as IssueStatus,
    reopenCount: updated.reopenCount,
    updatedAt: updated.updatedAt,
    terminal,
    unblockedDependents: txResult?.unblockedDependents ?? [],
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
};

type TransitionWriteResult = {
  row: { id: string; status: IssueStatus; reopenCount: number; updatedAt: Date };
  stampedOnClose: boolean;
  unblockedDependents: UnblockedDependent[];
};

async function executeTransitionWrite(input: TransitionWriteInput): Promise<TransitionWriteResult> {
  const { issue, fromStatus, requestedStatus, toStatus, actor, options, reopening } = input;
  const { declaredCriteria } = input;
  const draftGate =
    toStatus === 'draft' && !options.skip
      ? [
          sql`not exists (select 1 from pipeline_runs pr where pr.issue_id = ${issue.id}) and not exists (select 1 from jobs j where j.issue_id = ${issue.id})`,
        ]
      : [];
  try {
    return await db.transaction(async (tx) => {
      await options.beforeStatusWrite?.(tx);
      if (requiresAuthoredReason(fromStatus, requestedStatus) && options.skip !== true) {
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
        await mintParkQuestion({ issue, toStatus, actor, options }, tx);
      }
      const violation = await checkTransitionEvidence({
        issue: { id: issue.id, projectId: issue.projectId },
        toStatus: requestedStatus,
        agency: actorAgency(actor),
        skip: options.skip === true,
        declaredCriteria,
        executor: tx,
      });
      if (violation) throw new TransitionError(violation.code, violation.detail, violation.details);
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
              waitingKind: toStatus === 'waiting' ? (options.waitingKind ?? null) : null,
              updatedAt: sql`now()`,
            })
            .where(and(eq(issues.id, issue.id), eq(issues.status, fromStatus), ...draftGate))
            .returning({
              id: issues.id,
              status: issues.status,
              reopenCount: issues.reopenCount,
              updatedAt: issues.updatedAt,
            });
          if (!row) return null;
          const closeStamp = await markMergedOnClose(t, {
            issueId: issue.id,
            toStatus: requestedStatus,
          });
          const unblockedDependents =
            toStatus === 'dropped'
              ? await expireBlocksEdgesOnDrop(t, issue.projectId, issue.id)
              : [];
          return { row, stampedOnClose: closeStamp.stamped, unblockedDependents };
        },
      );
      if (!result)
        throw new TransitionError('STALE_TRANSITION', 'issue status changed concurrently', {
          from: fromStatus,
          to: toStatus,
        });
      return result;
    });
  } catch (error) {
    if (error instanceof TransitionError && error.code === 'STALE_TRANSITION' && draftGate.length) {
      throw await explainDraftRace(issue.id, fromStatus, toStatus);
    }
    throw error;
  }
}

/**
 * Device-actor convenience wrapper used by MCP tools and pipeline internals
 * (orchestrator, reconciler, finalize-failure, runs-control).
 * Same semantics as `transitionIssueStatus`; failures surface as
 * `TransitionError` (an `Error` with the legacy `CODE: detail` message) so
 * MCP tool handlers can wrap them uniformly.
 */
export async function applyStatusTransition(
  issue: TransitionIssueRow,
  toStatus: IssueStatus,
  device: DeviceLite,
  options: ApplyStatusTransitionOptions = {},
): Promise<StatusTransitionResult> {
  return transitionIssueStatus(issue, toStatus, { type: 'device', ...device }, options);
}
