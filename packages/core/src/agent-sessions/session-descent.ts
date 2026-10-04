/**
 * Closing a session closes what it owns.
 *
 * Every flip this writes carries {@link DESCENT_SOURCE}, and
 * `session-transition.ts:transitionSessions` skips a flip that already came from one: one walk per
 * terminal flip, and a cycle in the parent edge cannot spin.
 *
 * `session-transition.ts` imports this file at call time, so every import here is too — a static
 * edge back leaves this module's own top-level constants in their temporal dead zone while the
 * walk runs.
 */
import { RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { logger } from '../observability/logger.js';

export const DESCENT_SOURCE = 'session-descent';

/** Nothing forbids a cycle in a self-referencing column; hitting this is a defect. */
const MAX_DEPTH = 8;

interface DescentResult {
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

      const { transitionSessions } = await import('./session-transition.js');
      const flipped = (
        await transitionSessions(db, {
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
        })
      ).rows;
      if (flipped.length === 0) continue;
      result.closed.push(child.id);

      if (child.kind === RUN_SESSION_KIND) {
        // The flip handed its issues back (`session-transition.ts:transitionSessions`).
        const { closeRunIfOneShot } = await import('../pipeline/index.js');
        await closeRunIfOneShot(child.pipelineRunId, 'failed');
        result.runsReturned.push(child.pipelineRunId);
        logger.warn(
          { sessionId: child.id, runId: child.pipelineRunId, reason: cause.reason },
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
