/**
 * Giving back the issues a run session was carrying when its box stopped
 * answering.
 *
 * The local ledger on the box is the fast path and cannot be the only one:
 * a runner that lost power releases nothing at all. So this is the arm that
 * keys on the heartbeat, which stops on its own when a box vanishes.
 */

import {
  REVIEW_RUN_METADATA_KEY,
  RUN_ISSUES_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import { and, eq, sql } from 'drizzle-orm';
import { transitionSessions } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { closeRunIfOneShotInTx, lockRunForClose } from '../pipeline/index.js';
import { SESSION_SILENCE_TIMEOUT_S } from './session-silence.js';

interface ReapedRunSession {
  sessionId: string;
  runId: string;
  issueKeys: string[];
}

/**
 * Release run sessions whose box has gone silent, naming the issues freed, and end the review runs
 * a person declared whose time is up.
 */
export async function reapDeadRunSessions(): Promise<ReapedRunSession[]> {
  const staleSeconds = SESSION_SILENCE_TIMEOUT_S;
  // a review run (`review-run.ts`) has no process on its box to beat it: its clock is the end its
  // declaration names, never silence
  const rows = (await db.execute(sql`
    SELECT s.id, s.pipeline_run_id,
           COALESCE(r.metadata -> ${RUN_ISSUES_METADATA_KEY}, '[]'::jsonb) AS issue_keys
    FROM agent_sessions s
    JOIN pipeline_runs r ON r.id = s.pipeline_run_id
    WHERE s.kind = ${RUN_SESSION_KIND}
      AND s.status = 'running'
      AND r.metadata -> ${REVIEW_RUN_METADATA_KEY} IS NULL
      AND COALESCE(s.last_heartbeat_at, s.started_at, s.created_at)
          < now() - make_interval(secs => ${staleSeconds})
  `)) as unknown as Array<Record<string, unknown>>;

  const reaped: ReapedRunSession[] = [];
  for (const row of rows) {
    const sessionId = String(row.id);
    const runId = String(row.pipeline_run_id);
    const issueKeys = (row.issue_keys ?? []) as string[];
    // The run is locked first and closed with the session's flip, in one transaction (ISS-219).
    const flipped = await db.transaction(async (tx) => {
      await lockRunForClose(tx, runId);
      const rows = (
        await transitionSessions(tx, {
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
      if (rows.length > 0) {
        await closeRunIfOneShotInTx(tx, runId, 'failed', {
          code: 'runner_unreachable',
          detail: `its run session ${sessionId} stopped heartbeating for over ${staleSeconds}s, so the box running it is taken to be gone`,
        });
      }
      return rows.length > 0;
    });
    if (!flipped) continue;
    logger.warn(
      { runSessionId: sessionId, runId, issues: issueKeys },
      'run-session-reaper: released a run whose box stopped answering',
    );
    reaped.push({ sessionId, runId, issueKeys });
  }
  return [...reaped, ...(await endExpiredReviewRuns())];
}

/** A review run whose declared end has passed is over: completed, as a run closed at its end is. */
async function endExpiredReviewRuns(): Promise<ReapedRunSession[]> {
  const rows = (await db.execute(sql`
    SELECT s.id, s.pipeline_run_id, r.metadata -> ${REVIEW_RUN_METADATA_KEY} ->> 'expiresAt' AS expires_at
    FROM agent_sessions s
    JOIN pipeline_runs r ON r.id = s.pipeline_run_id
    WHERE s.kind = ${RUN_SESSION_KIND}
      AND s.status = 'running'
      AND (r.metadata -> ${REVIEW_RUN_METADATA_KEY} ->> 'expiresAt')::timestamptz <= now()
  `)) as unknown as Array<{ id: string; pipeline_run_id: string; expires_at: string }>;
  const ended: ReapedRunSession[] = [];
  for (const row of rows) {
    const flipped = await db.transaction(async (tx) => {
      await lockRunForClose(tx, row.pipeline_run_id);
      const moved = (
        await transitionSessions(tx, {
          to: 'completed',
          set: { updatedAt: new Date() },
          where: and(eq(agentSessions.id, row.id), eq(agentSessions.status, 'running')),
          reason: 'run_session_review_expired',
          actor: { type: 'system' },
          source: 'run-session-reaper',
        })
      ).rows;
      if (moved.length > 0) await closeRunIfOneShotInTx(tx, row.pipeline_run_id, 'completed');
      return moved.length > 0;
    });
    if (!flipped) continue;
    logger.info(
      { runSessionId: row.id, runId: row.pipeline_run_id, expiresAt: row.expires_at },
      'run-session-reaper: ended a review run at the end its declaration named',
    );
    ended.push({ sessionId: row.id, runId: row.pipeline_run_id, issueKeys: [] });
  }
  return ended;
}
