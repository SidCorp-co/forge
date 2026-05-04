import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { hooks } from '../pipeline/hooks.js';
import {
  REOPEN_CAP,
  canTransition,
  getAllowedTransitions,
  isReopenEntry,
} from '../pipeline/state-machine.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

export type DeviceLite = { id: string; ownerId: string };

export type TransitionIssueRow = {
  id: string;
  projectId: string;
  status: IssueStatus;
  reopenCount: number;
};

/**
 * Programmatic state-machine transition shared by MCP tools (forge_issues,
 * forge_pm.flag_blocker). Mirrors the REST `/transition` semantics — same
 * `canTransition` guard, conditional UPDATE keyed on current status,
 * `transition` hook + WS broadcast — but uses the device principal as the
 * actor and surfaces failures as `Error`s rather than HTTPException so MCP
 * tool handlers can wrap them uniformly.
 */
export async function applyStatusTransition(
  issue: TransitionIssueRow,
  toStatus: IssueStatus,
  device: DeviceLite,
): Promise<void> {
  const fromStatus = issue.status;
  if (fromStatus === toStatus) {
    throw new Error(`NO_OP: issue already in status ${toStatus}`);
  }

  if (!canTransition(fromStatus, toStatus)) {
    throw new Error(
      `ILLEGAL_TRANSITION: cannot transition ${fromStatus} → ${toStatus}; allowed: ${getAllowedTransitions(
        fromStatus,
      ).join(', ')}`,
    );
  }

  const reopening = isReopenEntry(fromStatus, toStatus);
  if (reopening && issue.reopenCount >= REOPEN_CAP) {
    throw new Error(`REOPEN_CAP_EXCEEDED: reopen cap reached (${REOPEN_CAP})`);
  }

  const [updated] = await db
    .update(issues)
    .set({
      status: toStatus,
      reopenCount: reopening ? sql`${issues.reopenCount} + 1` : issues.reopenCount,
      updatedAt: sql`now()`,
    })
    .where(and(eq(issues.id, issue.id), eq(issues.status, fromStatus)))
    .returning({
      id: issues.id,
      reopenCount: issues.reopenCount,
      updatedAt: issues.updatedAt,
    });
  if (!updated) {
    throw new Error('STALE_TRANSITION: issue status changed concurrently');
  }

  await hooks.emit('transition', {
    issueId: updated.id,
    projectId: issue.projectId,
    actor: { type: 'device' as const, id: device.id },
    from: fromStatus,
    to: toStatus,
    reopenCount: updated.reopenCount,
  });

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
}
