/**
 * Closing a session closes what it owns.
 *
 * Every flip this writes carries {@link DESCENT_SOURCE}, and the hook in
 * `lifecycle/transition.ts` skips a flip that already came from one: one walk
 * per terminal flip, and a cycle in the parent edge cannot spin.
 *
 * `transition.ts` imports this file at call time from inside the chokepoint, so
 * every import here is too — a static edge back leaves this module's own
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
 * A run session's leases are returned and its one-shot run closed failed.
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
      // Terminal children are selected too. They need no flip, but a live
      // grandchild under one is still owned by the root, and stopping at the
      // terminal row is how the closure silently stops being transitive.
      .where(inArray(agentSessions.parentSessionId, frontier));

    const next: string[] = [];
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      next.push(child.id);

      // Issues go back BEFORE the flip: nothing revisits a terminal run
      // session, so a return that threw after one stranded its issue for good.
      let returnedCount = 0;
      if (child.kind === RUN_SESSION_KIND) {
        try {
          const { returnIssuesForRun } = await import('../devices/run-issue-return.js');
          const { closeRunIfOneShot } = await import('../pipeline/runs.js');
          returnedCount = (
            await returnIssuesForRun(child.pipelineRunId, {
              reason: 'the session that started this run closed',
            })
          ).length;
          await closeRunIfOneShot(child.pipelineRunId, 'failed');
        } catch (err) {
          logger.error(
            { err, sessionId: child.id, runId: child.pipelineRunId, reason: cause.reason },
            'session-descent: a run session kept its issues because the return failed, so it was left open rather than closed over them',
          );
          continue;
        }
      }

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

      if (child.kind === RUN_SESSION_KIND) {
        result.runsReturned.push(child.pipelineRunId);
        logger.warn(
          {
            sessionId: child.id,
            runId: child.pipelineRunId,
            returned: returnedCount,
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
      'session-descent: the owner edge is deeper than a session tree can be, or it has a cycle — the walk stopped and anything owned below this point was never looked at',
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
