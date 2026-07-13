import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, comments, issues } from '../db/schema.js';
import { logger } from '../logger.js';
import { withActorContext } from '../pipeline/outbox-session.js';
import { closeOpenRunForIssue, setCurrentStepForOpenIssueRun } from '../pipeline/runs.js';
import {
  REOPEN_CAP,
  canTransitionFree,
  isReopenEntry,
} from '../pipeline/state-machine.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { markMergedIfLeavingBase, markMergedOnClose } from './merged-at.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';

/**
 * Issue statuses that close out the pipeline_run and satisfy a
 * `kind='blocks'` dependency edge (Layer 2).
 */
export const TERMINAL_FOR_DISPATCH = new Set<IssueStatus>(['released', 'closed']);

export type DeviceLite = { id: string; ownerId: string };

/**
 * Who is performing the transition. `id` feeds the outbox actor context
 * (ISS-196 trigger attribution); the WS `actorId` is the user id for user
 * actors and the device owner for device actors.
 */
export type TransitionActor =
  | { type: 'user'; id: string }
  | ({ type: 'device' } & DeviceLite);

export type TransitionErrorCode =
  | 'NO_OP'
  | 'ILLEGAL_TRANSITION'
  | 'REOPEN_CAP_EXCEEDED'
  | 'STALE_TRANSITION';

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
   * Bypass the `canTransition` state-machine check. The orchestrator's
   * soft-skip resolver (ISS-110) walks a curated forward chain
   * (`STAGE_FORWARD`) that intentionally collapses stages the state-machine
   * matrix wouldn't allow directly — e.g. `developed → testing` (skip
   * review+deploy). All other safety checks (NO_OP, reopen cap, stale
   * transition) still apply. Only the orchestrator should pass this.
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
   * Bypass the reopen cap. Authorization is the CALLER's job — the REST
   * route gates this on project-admin role before passing it through.
   */
  overrideReopenCap?: boolean | undefined;
}

export interface StatusTransitionResult {
  id: string;
  status: IssueStatus;
  reopenCount: number;
  updatedAt: Date;
  /**
   * `toStatus` entered `TERMINAL_FOR_DISPATCH`. The open run is already
   * closed by then; the Layer-2 dispatch fan-out (`triggerTerminalDispatch`)
   * is left to the caller so the batch route can fan out once per request
   * and programmatic callers can rely on the 60s pg-boss backstop.
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
 * REOPEN_CAP_EXCEEDED / STALE_TRANSITION); callers map it onto their own
 * error surface.
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

  const reopening = isReopenEntry(fromStatus, toStatus);
  if (reopening && issue.reopenCount >= REOPEN_CAP && !options.overrideReopenCap) {
    throw new TransitionError(
      'REOPEN_CAP_EXCEEDED',
      `reopen cap reached (${REOPEN_CAP})`,
      { reopenCount: issue.reopenCount, max: REOPEN_CAP },
    );
  }

  // Conditional UPDATE gates on current status so concurrent transitions
  // can't both win. activity_log write is owned by F5; do not insert here.
  //
  // ISS-196 — the AFTER UPDATE trigger on issues.status writes a row into
  // pipeline_outbox inside this transaction, so the outbox worker re-emits
  // the `transition` hook out-of-band. We wrap the UPDATE in
  // `withActorContext` so the trigger captures actor metadata via SET LOCAL
  // session settings.
  const txResult = await db.transaction((tx) =>
    withActorContext(
      tx,
      { type: actor.type, id: actor.id },
      options.reason ?? null,
      async (t) => {
        const [row] = await t
          .update(issues)
          .set({
            status: toStatus,
            reopenCount: reopening
              ? sql`${issues.reopenCount} + 1`
              : issues.reopenCount,
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
            toStatus,
          });
          // closed = done: a close from ANY surface satisfies the L2 blocks
          // gate. No-op when merged_at is already stamped (pipeline path).
          const closeStamp = await markMergedOnClose(t, {
            issueId: issue.id,
            toStatus,
          });
          stampedOnClose = closeStamp.stamped;
        }
        return row ? { row, stampedOnClose } : undefined;
      },
    ),
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
      await db.insert(comments).values({
        issueId: issue.id,
        authorId: actor.type === 'user' ? actor.id : actor.ownerId,
        body:
          'merged_at auto-stamped on close — `closed` counts as done, so `blocks`-dependents can now dispatch. ' +
          'If this issue was abandoned (its code never landed on the base branch), run `forge_issues` `unmark` to re-block dependents.',
        parentId: null,
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
  // terminal entries. No-ops when no open run exists (e.g. an issue that
  // transitions before any job is queued).
  await setCurrentStepForOpenIssueRun(issue.id, toStatus);
  const terminal = TERMINAL_FOR_DISPATCH.has(toStatus);
  if (terminal) {
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
): Promise<void> {
  await transitionIssueStatus(issue, toStatus, { type: 'device', ...device }, options);
}
