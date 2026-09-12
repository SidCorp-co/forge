/**
 * Giving back the issues a run session was carrying when its box stopped
 * answering.
 *
 * The local ledger on the box is the fast path and cannot be the only one:
 * a runner that lost power releases nothing at all. So this is the arm that
 * keys on the heartbeat, which stops on its own when a box vanishes.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { closeRunIfOneShot } from '../pipeline/runs.js';
import { returnIssuesForRun } from './run-issue-return.js';
import { RUN_ISSUES_METADATA_KEY, RUN_SESSION_TYPE } from './run-session.js';

/** How long a run session may go silent before its issues are given back. */
// cm:guard ten minutes is TWO of the daemon's slowest beat, not of its fastest: the sweep that beats normally runs every 30s but stretches to `LIMITED_POLL_INTERVAL` (5 min) on a rate-limited box, so a three-minute bound like the master's would reap a healthy run the moment the box got throttled. A run also holds a worktree and a branch, so taking it back early costs an operator a diff rather than a claim.
// cm:edge ordering -> packages/runner/crates/forge-runner-core/src/daemon/master.rs — `LIMITED_POLL_INTERVAL` is the number this is two of; raising it there without raising this reaps live runs.
export const RUN_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

export interface ReapedRunSession {
  sessionId: string;
  runId: string;
  issueKeys: string[];
}

/**
 * Release run sessions whose box has gone silent, naming the issues freed.
 */
// cm:guard the trigger is the heartbeat GOING SILENT, never the box reporting its own death. A sweep keyed on a socket drop or a close call recovers nothing at all from the failure it exists for — a box that lost power sends neither (ISS-933 criterion 25a).
// cm:guard the cutoff is computed by POSTGRES, for the two reasons `master-reaper.ts` gives: a `Date` bound through this driver throws at bind time, and a clock skew between app host and database would otherwise decide which boxes count as gone.
export async function reapDeadRunSessions(): Promise<ReapedRunSession[]> {
  const staleSeconds = Math.floor(RUN_SESSION_TIMEOUT_MS / 1000);
  const rows = (await db.execute(sql`
    SELECT s.id, s.pipeline_run_id,
           COALESCE(r.metadata -> ${RUN_ISSUES_METADATA_KEY}, '[]'::jsonb) AS issue_keys
    FROM agent_sessions s
    JOIN pipeline_runs r ON r.id = s.pipeline_run_id
    WHERE s.metadata->>'type' = ${RUN_SESSION_TYPE}
      AND s.status = 'running'
      AND COALESCE(s.last_heartbeat_at, s.started_at, s.created_at)
          < now() - make_interval(secs => ${staleSeconds})
  `)) as unknown as Array<Record<string, unknown>>;

  const reaped: ReapedRunSession[] = [];
  for (const row of rows) {
    const sessionId = String(row.id);
    const runId = String(row.pipeline_run_id);
    const issueKeys = (row.issue_keys ?? []) as string[];
    // cm:edge lockstep -> packages/core/src/lifecycle/transition.ts — the session flip routes through the chokepoint so it leaves a `kernel_transitions` row, and `transition-guard.test.ts` fails a literal terminal status written here directly.
    const flipped = await applyKernelTransition(db, {
      entity: 'session',
      to: 'failed',
      set: {
        failureReason: 'runner_unreachable',
        failureDetail: 'run-session-reaper: heartbeat stopped',
        updatedAt: new Date(),
      },
      where: and(eq(agentSessions.id, sessionId), eq(agentSessions.status, 'running')),
      fromStatus: 'running',
      reason: 'run_session_box_silent',
      actor: { type: 'system' },
      source: 'run-session-reaper',
    });
    // cm:guard the run closes only where the SESSION flip won. Two sweeps racing would otherwise both close the run and both log a release of the same group, and a release logged twice cannot be read as a fleet health signal.
    if (flipped.length === 0) continue;
    // cm:guard the issues are RETURNED here and not merely named. Until 2026-09-12 this loop read `issueKeys`, logged them and pushed them to its caller, which is why the module header promised to give issues back while the code gave back only the lease — and the lease lapses on its own, from the session going terminal one line above. The status did not: ISS-457 stood at `in_progress` for 18 hours behind a dead run, with ISS-410 queued behind it.
    const returned = await returnIssuesForRun(runId, {
      reason: 'the box running this issue stopped answering',
    });
    await closeRunIfOneShot(runId, 'failed');
    logger.warn(
      { runSessionId: sessionId, runId, issues: issueKeys, returned: returned.length },
      'run-session-reaper: released a run whose box stopped answering',
    );
    reaped.push({ sessionId, runId, issueKeys });
  }
  return reaped;
}

export const RUN_SESSION_REAPER_QUEUE = 'run-session-reaper';

let registered = false;

/** Run the sweep every minute, for the same reason the master reaper does. */
export async function registerRunSessionReaper(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(RUN_SESSION_REAPER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(RUN_SESSION_REAPER_QUEUE, async () => {
    const reaped = await reapDeadRunSessions();
    if (reaped.length > 0) {
      logger.info({ reaped: reaped.length }, 'run-session-reaper: sweep returned runs');
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(RUN_SESSION_REAPER_QUEUE, '* * * * *');
  registered = true;
}

export function resetRunSessionReaperForTest(): void {
  registered = false;
}
