// Resolve the pipeline job an agent's MCP call is running inside, so
// agent-facing tools can stamp issue/run/job provenance server-side instead of
// trusting the agent to supply it.
//
// The MCP context carries no job or session id (see McpContext in lib.ts), so
// the only handle is the calling device: find that device's non-terminal agent
// session, join to the job it backs, and take the most recently dispatched one.

import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';

// cm:guard NEVER narrow this to `= 'running'` — nothing in core ever writes that job status (queued → dispatched → terminal), so an equality test matches zero rows forever and every caller silently degrades. That was the whole of ISS-573/ISS-787: forge_ux_findings answered `no_active_issue` 100% of the time (zero rows on every project since the feature shipped) and forge_feedback recorded all 8 of its reports with null issueId/runId/jobId/stage.
// cm:edge lockstep -> packages/core/src/jobs/queued-gates.ts — "in flight" must match `runner_load` there, NOT the wider `issueBusyJob` set: `held` is deliberately absent from both, because a held job has no live agent to attribute a tool call to (RFC 0002)
const IN_FLIGHT_JOB_STATUSES = ['dispatched', 'running'] as const;

// cm:edge lockstep -> packages/core/src/pipeline/runs-cascade.ts — same non-terminal session set the cascade treats as active. `queued` MUST stay in it: a pipeline session is inserted `queued` and only flips to `running` on its first job-event batch (jobs/events-routes.ts), so an agent that calls a tool before that batch lands is still `queued`.
const ACTIVE_SESSION_STATUSES = ['queued', 'running', 'idle'] as const;

export type ActiveJobContext = {
  jobId: string;
  runId: string;
  issueId: string | null;
  /** The job's type — `review`, `test`, `code`, … — recorded as the emitting stage. */
  stage: string;
};

/**
 * The in-flight pipeline job for `deviceId`, or `null` when the caller is not
 * running inside one (interactive sessions, PAT callers, schedule/steward runs
 * that have no job row).
 *
 * A runner whose cap allows more than one concurrent job can have several
 * in-flight at once; without a job id on the MCP context there is no way to
 * tell which one is calling, so the most recently dispatched wins.
 */
export async function resolveActiveJobContext(deviceId: string): Promise<ActiveJobContext | null> {
  const [row] = await db
    .select({
      jobId: jobs.id,
      runId: jobs.pipelineRunId,
      issueId: jobs.issueId,
      stage: jobs.type,
    })
    .from(agentSessions)
    .innerJoin(jobs, eq(jobs.agentSessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.deviceId, deviceId),
        inArray(agentSessions.status, ACTIVE_SESSION_STATUSES),
        inArray(jobs.status, IN_FLIGHT_JOB_STATUSES),
      ),
    )
    .orderBy(desc(jobs.dispatchedAt))
    .limit(1);
  return row ?? null;
}
