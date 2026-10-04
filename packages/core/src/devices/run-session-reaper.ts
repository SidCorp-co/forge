/**
 * Giving back the issues a run session was carrying when its box stopped
 * answering.
 *
 * The local ledger on the box is the fast path and cannot be the only one:
 * a runner that lost power releases nothing at all. So this is the arm that
 * keys on the heartbeat, which stops on its own when a box vanishes.
 */

import { and, eq, sql } from 'drizzle-orm';
import { transitionSessions } from '../agent-sessions/session-transition.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { logger } from '../observability/logger.js';
import { closeRunIfOneShot } from '../pipeline/runs.js';
import { RUN_ISSUES_METADATA_KEY, RUN_SESSION_KIND } from './run-session.js';
import { SESSION_SILENCE_TIMEOUT_S } from './session-silence.js';

export interface ReapedRunSession {
  sessionId: string;
  runId: string;
  issueKeys: string[];
}

/**
 * Release run sessions whose box has gone silent, naming the issues freed.
 */
export async function reapDeadRunSessions(): Promise<ReapedRunSession[]> {
  const staleSeconds = SESSION_SILENCE_TIMEOUT_S;
  const rows = (await db.execute(sql`
    SELECT s.id, s.pipeline_run_id,
           COALESCE(r.metadata -> ${RUN_ISSUES_METADATA_KEY}, '[]'::jsonb) AS issue_keys
    FROM agent_sessions s
    JOIN pipeline_runs r ON r.id = s.pipeline_run_id
    WHERE s.kind = ${RUN_SESSION_KIND}
      AND s.status = 'running'
      AND COALESCE(s.last_heartbeat_at, s.started_at, s.created_at)
          < now() - make_interval(secs => ${staleSeconds})
  `)) as unknown as Array<Record<string, unknown>>;

  const reaped: ReapedRunSession[] = [];
  for (const row of rows) {
    const sessionId = String(row.id);
    const runId = String(row.pipeline_run_id);
    const issueKeys = (row.issue_keys ?? []) as string[];
    const flipped = (
      await transitionSessions(db, {
        to: 'failed',
        set: {
          failureReason: 'runner_unreachable',
          failureDetail: 'run-session-reaper: heartbeat stopped',
          updatedAt: new Date(),
        },
        where: and(eq(agentSessions.id, sessionId), eq(agentSessions.status, 'running')),
        reason: 'run_session_box_silent',
        actor: { type: 'system' },
        source: 'run-session-reaper',
      })
    ).rows;
    if (flipped.length === 0) continue;
    await closeRunIfOneShot(runId, 'failed');
    logger.warn(
      { runSessionId: sessionId, runId, issues: issueKeys },
      'run-session-reaper: released a run whose box stopped answering',
    );
    reaped.push({ sessionId, runId, issueKeys });
  }
  return reaped;
}
