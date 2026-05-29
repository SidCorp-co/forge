import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { withActorContext } from '../pipeline/outbox-session.js';
import { closeOpenRunForIssue, setCurrentStepForOpenIssueRun } from '../pipeline/runs.js';
import {
  REOPEN_CAP,
  canTransitionFree,
  isReopenEntry,
} from '../pipeline/state-machine.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { markMergedIfLeavingBase } from './merged-at.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';

/** Issue statuses that close out the pipeline_run (mirror of transition.ts). */
const TERMINAL_RUN_STATUSES = new Set<IssueStatus>(['released', 'closed']);

export type DeviceLite = { id: string; ownerId: string };

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
}

/**
 * Programmatic state-machine transition shared by MCP tools (currently only
 * `forge_issues`). Mirrors the REST `/transition` semantics — same
 * `canTransition` guard, conditional UPDATE keyed on current status,
 * `transition` hook + WS broadcast — but uses the device principal as the
 * actor and surfaces failures as `Error`s rather than HTTPException so MCP
 * tool handlers can wrap them uniformly.
 */
export async function applyStatusTransition(
  issue: TransitionIssueRow,
  toStatus: IssueStatus,
  device: DeviceLite,
  options: ApplyStatusTransitionOptions = {},
): Promise<void> {
  const fromStatus = issue.status;
  if (fromStatus === toStatus) {
    throw new Error(`NO_OP: issue already in status ${toStatus}`);
  }

  // Transitions are intentionally permissive (the system prompt guides the
  // happy path); only `draft` is a forbidden target. `skip` still bypasses
  // even that for the orchestrator's curated soft-skip chain.
  if (!options.skip && !canTransitionFree(fromStatus, toStatus)) {
    throw new Error(
      `ILLEGAL_TRANSITION: '${toStatus}' is not a valid runtime status target`,
    );
  }

  const reopening = isReopenEntry(fromStatus, toStatus);
  if (reopening && issue.reopenCount >= REOPEN_CAP) {
    throw new Error(`REOPEN_CAP_EXCEEDED: reopen cap reached (${REOPEN_CAP})`);
  }

  // ISS-196 — the AFTER UPDATE trigger on issues.status writes a row into
  // pipeline_outbox inside this transaction. `withActorContext` carries the
  // device principal through SET LOCAL session settings so the trigger
  // attributes the row correctly.
  const updated = await db.transaction((tx) =>
    withActorContext(
      tx,
      { type: 'device', id: device.id },
      null,
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
            reopenCount: issues.reopenCount,
            updatedAt: issues.updatedAt,
          });
        if (row) {
          // ISS-232 — stamp `merged_at` inside the same tx so a rollback
          // drops the column write alongside the status flip.
          await markMergedIfLeavingBase(t, {
            issueId: issue.id,
            projectId: issue.projectId,
            fromStatus,
            toStatus,
          });
        }
        return row;
      },
    ),
  );
  if (!updated) {
    throw new Error('STALE_TRANSITION: issue status changed concurrently');
  }

  // ISS-101 — keep run timeline in sync with issue status, then close it on
  // terminal entries. No-ops when no open run exists (e.g. an issue that
  // transitions before any job is queued).
  await setCurrentStepForOpenIssueRun(issue.id, toStatus);
  if (TERMINAL_RUN_STATUSES.has(toStatus)) {
    await closeOpenRunForIssue(issue.id, 'completed');
  }

  roomManager.publish(projectRoom(issue.projectId), {
    event: 'issue.statusChanged',
    data: {
      issueId: updated.id,
      from: fromStatus,
      to: toStatus,
      reopenCount: updated.reopenCount,
      actorId: device.ownerId,
      reason: null,
      at: updated.updatedAt,
    },
  });

  // ISS-164 — refresh derived pipelineHealth (stage mirrors issues.status).
  await publishPipelineHealthChanged(issue.projectId, [updated.id]);
}
