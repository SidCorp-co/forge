// Resolve the pipeline job an agent's MCP call is running inside, so
// agent-facing tools can stamp issue/run/job provenance server-side instead of
// trusting the agent to supply it.
//
// The handle is the CALLER'S OWN TOKEN. A machine credential is named
// `job:<jobId>` or `session:<sessionId>` (auth/pat-format.ts), so the job is
// identified exactly rather than guessed from which box is busy.

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { MachineTokenRef } from '../auth/pat-format.js';
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
  /** The box the job was dispatched to, for the columns that still record one. */
  deviceId: string | null;
  agentSessionId: string | null;
};

/**
 * The pipeline job a machine token was minted for, or `null` when the caller
 * holds a person's PAT (no `job:`/`session:` name) or the job/session has since
 * gone terminal.
 *
 * A `job:` token answers directly. A `session:` token — an unattended chat or
 * schedule session — answers through the job that session backs, if any; a
 * steward or interactive session legitimately has none.
 */
// cm:why keyed on the token and not on `devices.id` any more (ISS-931). The device lookup had to take "the most recently dispatched job on that box" because the MCP context carried no job id, so a runner at concurrency 3 attributed a tool call to whichever of its three jobs was newest. The token names one job, so there is nothing left to guess — and it is the same reason a session PAT can reach this at all, having no device to look up.
export async function resolveMachineTokenContext(
  ref: MachineTokenRef | null,
): Promise<ActiveJobContext | null> {
  if (!ref) return null;
  if (ref.kind === 'job') {
    const [row] = await db
      .select({
        jobId: jobs.id,
        runId: jobs.pipelineRunId,
        issueId: jobs.issueId,
        stage: jobs.type,
        deviceId: jobs.deviceId,
        agentSessionId: jobs.agentSessionId,
      })
      .from(jobs)
      .where(and(eq(jobs.id, ref.id), inArray(jobs.status, IN_FLIGHT_JOB_STATUSES)))
      .limit(1);
    return row ?? null;
  }
  const [row] = await db
    .select({
      jobId: jobs.id,
      runId: jobs.pipelineRunId,
      issueId: jobs.issueId,
      stage: jobs.type,
      deviceId: jobs.deviceId,
      agentSessionId: jobs.agentSessionId,
    })
    .from(agentSessions)
    .innerJoin(jobs, eq(jobs.agentSessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.id, ref.id),
        inArray(agentSessions.status, ACTIVE_SESSION_STATUSES),
        inArray(jobs.status, IN_FLIGHT_JOB_STATUSES),
      ),
    )
    .orderBy(desc(jobs.dispatchedAt))
    .limit(1);
  return row ?? null;
}

/**
 * The device a machine token's session is running on, for the columns that
 * still record one. `null` for a person's PAT, and for a session with no
 * device row (a cloud/schedule session).
 */
export async function resolveMachineTokenDeviceId(
  ref: MachineTokenRef | null,
): Promise<string | null> {
  if (!ref) return null;
  if (ref.kind === 'session') {
    const [row] = await db
      .select({ deviceId: agentSessions.deviceId })
      .from(agentSessions)
      .where(eq(agentSessions.id, ref.id))
      .limit(1);
    return row?.deviceId ?? null;
  }
  const [row] = await db
    .select({ deviceId: jobs.deviceId })
    .from(jobs)
    .where(eq(jobs.id, ref.id))
    .limit(1);
  return row?.deviceId ?? null;
}
