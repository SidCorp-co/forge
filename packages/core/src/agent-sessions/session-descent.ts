/**
 * Closing a session closes what it owns.
 *
 * Every flip this writes carries {@link DESCENT_SOURCE}, and the hook in
 * `lifecycle/transition.ts` skips a flip that already came from one: one walk
 * per terminal flip, and a cycle in the parent edge cannot spin.
 *
 * `transition.ts` imports this file at call time from inside the chokepoint, so
 * every import here is at call time too — a static edge back to it, directly or
 * through `run-session.ts` or `pipeline/runs.ts`, leaves this module's own
 * top-level constants in their temporal dead zone while the walk runs.
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { RUN_SESSION_KIND } from '../jobs/session-kinds.js';
import { logger } from '../logger.js';

export const DESCENT_SOURCE = 'session-descent';

/** Nothing forbids a cycle in a self-referencing column; hitting this is a defect. */
const MAX_DEPTH = 8;

export interface DescentResult {
  closed: string[];
  runsReturned: string[];
}

/**
 * Close every non-terminal session owned, transitively, by one of `parentIds`.
 *
 * A run session goes back through the path its own reaper uses: leases returned,
 * one-shot run closed failed. Anything else is flipped and holds no lease.
 */
export async function closeSessionsOwnedBy(
  parentIds: readonly string[],
  cause: { reason: string; detail: string },
): Promise<DescentResult> {
  const result: DescentResult = { closed: [], runsReturned: [] };
  if (parentIds.length === 0) return result;

  const seen = new Set<string>(parentIds);
  let frontier = [...parentIds];

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const children = await db
      .select({
        id: agentSessions.id,
        kind: agentSessions.kind,
        pipelineRunId: agentSessions.pipelineRunId,
      })
      .from(agentSessions)
      .where(
        and(
          inArray(agentSessions.parentSessionId, frontier),
          notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
        ),
      );

    const next: string[] = [];
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      const { applyKernelTransition } = await import('../lifecycle/transition.js');
      const flipped = await applyKernelTransition(db, {
        entity: 'session',
        to: 'failed',
        set: {
          failureReason: 'session_lost',
          failureDetail: cause.detail,
          updatedAt: new Date(),
        },
        where: and(
          eq(agentSessions.id, child.id),
          notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
        ),
        returning: ['id'],
        reason: cause.reason,
        actor: { type: 'system' },
        source: DESCENT_SOURCE,
      });
      if (flipped.length === 0) continue;
      result.closed.push(child.id);
      next.push(child.id);

      if (child.kind === RUN_SESSION_KIND) {
        const { returnIssuesForRun } = await import('../devices/run-issue-return.js');
        const { closeRunIfOneShot } = await import('../pipeline/runs.js');
        const returned = await returnIssuesForRun(child.pipelineRunId, {
          reason: 'the session that started this run closed',
        });
        await closeRunIfOneShot(child.pipelineRunId, 'failed');
        result.runsReturned.push(child.pipelineRunId);
        logger.warn(
          {
            sessionId: child.id,
            runId: child.pipelineRunId,
            returned: returned.length,
            reason: cause.reason,
          },
          'session-descent: a run session closed with its owner, and its issues went back',
        );
      }
    }
    frontier = next;
  }

  if (frontier.length > 0) {
    logger.error(
      { roots: [...parentIds], depth: MAX_DEPTH, stillOpen: frontier },
      'session-descent: the owner edge is deeper than a session tree can be, or it has a cycle — the walk stopped and rows below this point are still open',
    );
  }

  if (result.closed.length > 0) {
    logger.info(
      { roots: [...parentIds], closed: result.closed.length, reason: cause.reason },
      'session-descent: closed the sessions a closed session owned',
    );
  }
  return result;
}
