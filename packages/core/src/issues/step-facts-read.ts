/** What one issue's step outcomes (`step-outcomes.ts`) are read from, for its peek and its page. */

import type { IssueStepHandoff } from '@forge/contracts/issue-standing';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { handoffContextsOf } from './ports.js';
import type { StepDurationFact } from './step-outcomes.js';

/** The handoffs, step durations and newest failed job one issue's step outcomes are read from. */
export async function stepFactsOf(projectId: string, issueId: string) {
  const [contexts, durations, failed] = await Promise.all([
    handoffContextsOf(projectId, issueId),
    db.execute(sql`
      SELECT run_id, step, duration_seconds, cost_usd, coalesce(finished_at, started_at) AS at
        FROM pipeline_run_step_durations
       WHERE project_id = ${projectId} AND issue_id = ${issueId} AND duration_seconds IS NOT NULL`),
    db.execute(sql`
      SELECT type FROM jobs WHERE issue_id = ${issueId} AND status = 'failed'
       ORDER BY finished_at DESC NULLS LAST LIMIT 1`),
  ]);
  const handoffs: IssueStepHandoff[] = contexts.flatMap((c) =>
    c.step
      ? [
          {
            id: c.id,
            step: c.step,
            attempt: c.attempt,
            pipelineRunId: c.pipelineRunId,
            payload:
              c.payload && typeof c.payload === 'object'
                ? (c.payload as Record<string, unknown>)
                : null,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          },
        ]
      : [],
  );
  const facts: StepDurationFact[] = rowsOf<{
    run_id: string;
    step: string;
    duration_seconds: number;
    cost_usd: number | null;
    at: string | Date;
  }>(durations).map((d) => ({
    runId: d.run_id,
    step: d.step,
    durationSeconds: Number(d.duration_seconds),
    costUsd: Number(d.cost_usd ?? 0),
    at: new Date(d.at).toISOString(),
  }));
  const [last] = rowsOf<{ type: string }>(failed);
  return { handoffs, durations: facts, failedStep: last?.type ?? null };
}
