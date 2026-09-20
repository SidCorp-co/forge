/**
 * Closing a session closes what it owns.
 *
 * A child session runs as a subagent inside its parent's Claude session, so it
 * cannot outlive the parent: once the parent is terminal, every open row
 * beneath it describes work nobody is doing. Before `agent_sessions` had a
 * `parent_session_id`, neither reaper could name a child, and the two clocks
 * they ran on left a window where a master was gone and the runs it started
 * still held their issue leases (ISS-1136).
 *
 * The walk is iterative and its own recursion is suppressed by `source`: every
 * flip it writes carries {@link DESCENT_SOURCE}, and the hook in
 * `lifecycle/transition.ts` that starts a descent skips a flip that already came
 * from one. That is what keeps one walk per terminal flip instead of a walk per
 * row, and it is why a cycle in the parent edge cannot spin.
 */

import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { RUN_SESSION_KIND } from '../devices/run-session.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { closeRunIfOneShot } from '../pipeline/runs.js';

/** The `source` every flip a descent writes carries. */
export const DESCENT_SOURCE = 'session-descent';

/**
 * How deep one descent will walk before it refuses to go further.
 *
 * The real tree is two deep — a master and the runs it started. This exists
 * because `parent_session_id` is a self-referencing column and nothing in the
 * database forbids a cycle, and a walk that met one would otherwise not
 * terminate. Hitting it is a defect, so it is logged as an error naming the
 * roots rather than quietly stopping.
 */
const MAX_DEPTH = 8;

export interface DescentResult {
  /** Session ids this descent flipped terminal, parents first. */
  closed: string[];
  /** Run sessions whose issue leases were handed back, by run id. */
  runsReturned: string[];
}

/**
 * Close every non-terminal session owned, transitively, by one of `parentIds`.
 *
 * A run session closed here goes back through the same path its own reaper
 * uses: the leases it was carrying are returned and its one-shot run is closed
 * failed. Anything else is simply flipped, because a chat or a pipeline session
 * holds no lease of its own.
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
        // Imported here rather than at the top: run-issue-return reaches back
        // into the devices module, and a static edge from here would close a
        // cycle through `run-session.ts`.
        const { returnIssuesForRun } = await import('../devices/run-issue-return.js');
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
