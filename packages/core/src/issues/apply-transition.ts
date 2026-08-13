import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, type IssueStatus, issues } from '../db/schema.js';
import { logger } from '../logger.js';
import { withActorContext } from '../pipeline/outbox-session.js';
import { closeOpenRunForIssue, setCurrentStepForOpenIssueRun } from '../pipeline/runs.js';
import { canTransitionFree, isReopenEntry } from '../pipeline/state-machine.js';
import { collectWorkEvidence, hasCodeEvidence } from '../pipeline/work-evidence.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { markMergedIfLeavingBase, markMergedOnClose } from './merged-at.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';
import { postReopenReasonComment } from './reopen-reason.js';
import { checkTransitionEvidence } from './transition-evidence.js';

/**
 * Issue statuses that satisfy a `kind='blocks'` dependency edge (Layer 2) and
 * fire the terminal dispatch fan-out. Does NOT imply the run closes here —
 * see `RUN_CLOSING_STATUSES`.
 */
export const TERMINAL_FOR_DISPATCH = new Set<IssueStatus>(['released', 'closed']);

/**
 * Statuses that close the issue's open `pipeline_run`. Only `closed`:
 * `released` is ALSO the `release` job's dispatch-trigger status
 * (registry.ts), so closing the run on `released` orphaned it and forced the
 * release step into a brand-new run every time (ISS-669's re-run cascade).
 * Leaving the run open on `released` lets the release step run inside it;
 * the run closes when release finishes and sets `closed`.
 */
export const RUN_CLOSING_STATUSES = new Set<IssueStatus>(['closed']);

export type DeviceLite = { id: string; ownerId: string };

/**
 * Who is performing the transition. `id` feeds the outbox actor context
 * (ISS-196 trigger attribution); the WS `actorId` is the user id for user
 * actors and the device owner for device actors.
 */
export type TransitionActor = { type: 'user'; id: string } | ({ type: 'device' } & DeviceLite);

export type TransitionErrorCode =
  | 'NO_OP'
  | 'ILLEGAL_TRANSITION'
  | 'REOPEN_REASON_REQUIRED'
  | 'STALE_TRANSITION'
  | 'PLAN_REQUIRED'
  | 'NO_WORK_EVIDENCE';

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

export interface ApplyStatusTransitionOptions {
  /**
   * Bypass `canTransitionFree`. In practice that guard only forbids `draft`
   * as a target and restricts `draft`'s own exits, so this flag buys exactly
   * two things: entering `draft` (nothing does) and moving a `draft` issue to
   * a status outside {open, closed, developed} — which is what the decompose
   * cascade needs to promote children straight to `approved`. The soft-skip
   * resolver (ISS-110) also passes it while walking `STAGE_FORWARD`.
   *
   * It is NOT a general safety override: NO_OP, stale-transition detection and
   * every content guard still run. Callers are the orchestrator and the
   * decomposition subscriber.
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
   * Why this issue is being reopened, in the actor's own words. REQUIRED on a
   * reopen entry and posted as a comment before the status write.
   */
  // cm:guard required, not advisory (RFC 0002 INV-8) — the reason is what the fix step scopes against, and the guards deleted with the reopen cap were all attempts to detect its absence AFTER the fact; rejecting the write is the only version that cannot strand an issue
  reopenReason?: string | undefined;
}

export interface StatusTransitionResult {
  id: string;
  status: IssueStatus;
  reopenCount: number;
  updatedAt: Date;
  /**
   * `toStatus` entered `TERMINAL_FOR_DISPATCH`. The Layer-2 dispatch fan-out
   * (`triggerTerminalDispatch`) is left to the caller so the batch route can
   * fan out once per request and programmatic callers can rely on the 60s
   * pg-boss backstop. The open run is closed separately, only when `toStatus`
   * is in `RUN_CLOSING_STATUSES` (ISS-669 — `released` no longer closes it).
   */
  terminal: boolean;
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
 * THE issue state-machine writer. Every surface — REST `/transition`,
 * REST `PATCH /batch`, MCP `forge_issues`, orchestrator soft-skip,
 * reconciler, decompose cascade, finalize-failure — routes through here so
 * guard semantics, the conditional UPDATE, `merged_at` stamping, WS
 * broadcast, pipeline-health refresh and run close cannot drift apart.
 *
 * Throws `TransitionError` (NO_OP / ILLEGAL_TRANSITION /
 * REOPEN_REASON_REQUIRED / STALE_TRANSITION / PLAN_REQUIRED); callers map it
 * onto their own error surface.
 */
export async function transitionIssueStatus(
  issue: TransitionIssueRow,
  toStatus: IssueStatus,
  actor: TransitionActor,
  options: ApplyStatusTransitionOptions = {},
): Promise<StatusTransitionResult> {
  const fromStatus = issue.status;
  if (fromStatus === toStatus) {
    throw new TransitionError('NO_OP', `issue already in status ${toStatus}`, {
      status: fromStatus,
    });
  }

  // Transitions are intentionally permissive (the system prompt guides the
  // happy path); only `draft` is a forbidden target. `skip` still bypasses
  // even that for the orchestrator's curated soft-skip chain.
  if (!options.skip && !canTransitionFree(fromStatus, toStatus)) {
    throw new TransitionError(
      'ILLEGAL_TRANSITION',
      `'${toStatus}' is not a valid runtime status target`,
      { from: fromStatus, to: toStatus },
    );
  }

  // cm:guard the reason is posted BEFORE the status write, and a failed post must reject the whole transition — a reopen whose rationale is missing is exactly the state the deleted bounce/empty-reopen guards existed to detect afterwards, and every one of them detected it by stranding the issue at `needs_info`
  if (isReopenEntry(fromStatus, toStatus) && options.skip !== true) {
    const reopenReason = options.reopenReason?.trim();
    if (!reopenReason) {
      throw new TransitionError(
        'REOPEN_REASON_REQUIRED',
        'a reopen must carry a reason describing what regressed or what is still wrong',
        { from: fromStatus, to: toStatus },
      );
    }
    await postReopenReasonComment({
      issueId: issue.id,
      authorId: actor.type === 'user' ? actor.id : actor.ownerId,
      fromStatus,
      reason: reopenReason,
      isAi: actor.type !== 'user',
    });
  }

  // cm:why skip exempts auto-skip/failover (both pass {skip:true} into `approved`) — only an unskipped device write is the fabrication class this guards against
  const violation = await checkTransitionEvidence({
    issue: { id: issue.id, projectId: issue.projectId },
    toStatus,
    actorType: actor.type,
    skip: options.skip === true,
  });
  if (violation) {
    throw new TransitionError(violation.code, violation.detail, violation.details);
  }

  const reopening = isReopenEntry(fromStatus, toStatus);

  // cm:flow dispatch/transition — the status UPDATE commits and an AFTER UPDATE trigger enqueues the outbox row in this same transaction
  // cm:guard the UPDATE below must stay conditional on the CURRENT status, or two concurrent transitions both win and the loser's status is silently overwritten
  // cm:guard never insert into activity_log here — F5 owns that write, and a second one double-counts every transition
  // cm:edge sideeffect -> packages/core/drizzle/migrations/0070_pipeline_outbox.sql — trg_issues_status_outbox fires on this UPDATE and writes pipeline_outbox; no call site references it, so a reader of this file cannot see the row being produced
  // cm:why withActorContext wraps the UPDATE because the trigger reads actor metadata off SET LOCAL session settings — outside the wrapper the outbox row is written with no actor at all
  const txResult = await db.transaction((tx) =>
    withActorContext(tx, { type: actor.type, id: actor.id }, options.reason ?? null, async (t) => {
      const [row] = await t
        .update(issues)
        .set({
          status: toStatus,
          reopenCount: reopening ? sql`${issues.reopenCount} + 1` : issues.reopenCount,
          updatedAt: sql`now()`,
        })
        .where(and(eq(issues.id, issue.id), eq(issues.status, fromStatus)))
        .returning({
          id: issues.id,
          status: issues.status,
          reopenCount: issues.reopenCount,
          updatedAt: issues.updatedAt,
        });
      let stampedOnClose = false;
      if (row) {
        // ISS-232 — stamp `merged_at` inside the same tx so a rollback
        // drops the column write alongside the status flip.
        await markMergedIfLeavingBase(t, {
          issueId: issue.id,
          projectId: issue.projectId,
          fromStatus,
          toStatus: toStatus,
        });
        // closed = done: a close from ANY surface satisfies the L2 blocks
        // gate. No-op when merged_at is already stamped (pipeline path).
        const closeStamp = await markMergedOnClose(t, {
          issueId: issue.id,
          toStatus: toStatus,
        });
        stampedOnClose = closeStamp.stamped;
      }
      return row ? { row, stampedOnClose } : undefined;
    }),
  );
  const updated = txResult?.row;
  if (!updated) {
    throw new TransitionError('STALE_TRANSITION', 'issue status changed concurrently', {
      from: fromStatus,
      to: toStatus,
    });
  }

  publishIssueStatusChange(issue.projectId, {
    issueId: updated.id,
    from: fromStatus,
    to: toStatus,
    reopenCount: updated.reopenCount,
    actorId: actor.type === 'user' ? actor.id : actor.ownerId,
    reason: options.reason ?? null,
    at: updated.updatedAt,
  });

  // Audit trail for the close-time stamp: only fires when the close is what
  // stamped merged_at (hand/MCP closes of never-merged issues — the pipeline
  // path stamped earlier on leaving the base merge state, so it stays quiet).
  // Best-effort: the transition already committed; losing the comment must
  // not fail the caller.
  if (txResult?.stampedOnClose) {
    try {
      // ISS-786 child B, requirement 5 — name whether any code evidence
      // exists so a false unblock (ISS-75/76/77/78 shape) becomes visible
      // instead of silent. Best-effort: a read failure here must not change
      // the comment into a false-negative claim, so it falls back to the
      // evidence-exists text (unmark is still the correct remedy either way).
      const evidenceFound = await collectWorkEvidence(issue.id)
        .then(hasCodeEvidence)
        .catch(() => true);
      const evidenceNote = evidenceFound
        ? 'If this issue was abandoned (its code never landed on the base branch), run `forge_issues` `unmark` to re-block dependents.'
        : 'No branch, commit or code handoff is recorded for this issue — if its code never landed, run `forge_issues` `unmark` to re-block dependents.';
      // cm:guard ISS-820 — automated system comment; isAi:true, same dishonest-authorship class as the MCP audit comments
      await db.insert(comments).values({
        issueId: issue.id,
        authorId: actor.type === 'user' ? actor.id : actor.ownerId,
        body: `merged_at auto-stamped on close — \`closed\` counts as done, so \`blocks\`-dependents can now dispatch. ${evidenceNote}`,
        parentId: null,
        isAi: true,
      });
    } catch (err) {
      logger.warn(
        { err, issueId: issue.id },
        'transition: close-stamp audit comment failed (transition already committed)',
      );
    }
  }

  // ISS-164 — refresh derived pipelineHealth (stage mirrors issues.status).
  await publishPipelineHealthChanged(issue.projectId, [updated.id]);

  // ISS-101 — keep run timeline in sync with issue status, then close it on
  // RUN_CLOSING_STATUSES entries. No-ops when no open run exists (e.g. an
  // issue that transitions before any job is queued).
  await setCurrentStepForOpenIssueRun(issue.id, toStatus);
  const terminal = TERMINAL_FOR_DISPATCH.has(toStatus);
  if (RUN_CLOSING_STATUSES.has(toStatus)) {
    await closeOpenRunForIssue(issue.id, 'completed');
  }

  return {
    id: updated.id,
    status: updated.status as IssueStatus,
    reopenCount: updated.reopenCount,
    updatedAt: updated.updatedAt,
    terminal,
  };
}

/**
 * Device-actor convenience wrapper used by MCP tools and pipeline internals
 * (orchestrator, reconciler, decompose, finalize-failure, runs-control).
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
