// Resolve the agent session an MCP call is running inside — and the job that
// session is running, when it has one — so agent-facing tools stamp provenance
// server-side instead of trusting the agent to supply it.
//
// The handle is the CALLER'S BOX, fenced by the token's project. An agent
// credential carries `device_id` (the box it was issued to) and
// `bound_project_id` (the one project it may reach), and those two together
// name at most one live session. Nothing is read off the token's NAME, and
// nothing is passed by the caller.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';

// cm:guard NEVER narrow this to `= 'running'` — nothing in core ever writes that job status (queued → dispatched → terminal), so an equality test matches zero rows forever and every caller silently degrades (ISS-573/ISS-787: forge_ux_findings answered `no_active_issue` on 100% of calls, and forge_feedback recorded all 8 reports with null issueId/runId/jobId/stage).
// cm:edge lockstep -> packages/core/src/jobs/queued-gates.ts — "in flight" must match `runner_load` there, NOT the wider `issueBusyJob` set: `held` is deliberately absent from both, because a held job has no live agent to attribute a tool call to (RFC 0002)
const IN_FLIGHT_JOB_STATUSES = ['dispatched', 'running'] as const;

// cm:edge lockstep -> packages/core/src/pipeline/runs-cascade.ts — same non-terminal session set the cascade treats as active. `queued` MUST stay in it: a pipeline session is inserted `queued` and only flips to `running` on its first job-event batch (jobs/events-routes.ts), so an agent that calls a tool before that batch lands is still `queued`.
const ACTIVE_SESSION_STATUSES = ['queued', 'running', 'idle'] as const;

export type ActiveJobContext = {
  /** Always present: the session IS the context, and a job is what it may be running. */
  agentSessionId: string;
  /** Null for a session with no job — a steward or schedule run (ISS-557). */
  jobId: string | null;
  runId: string | null;
  issueId: string | null;
  /** The job's type — `review`, `test`, `code`, … — recorded as the emitting stage. */
  stage: string | null;
  /** The box the session is running on, for the columns that still record one. */
  deviceId: string | null;
};

/** What a caller holds: the two fields that together name a job. */
export type PipelineCaller = {
  deviceId: string | null;
  boundProjectId: string | null;
};

export type PipelineContextResult =
  | { ok: true; context: ActiveJobContext }
  | { ok: false; reason: 'not_pipeline_context' | 'ambiguous_pipeline_context'; detail: string };

/**
 * The pipeline job this credential is running inside.
 *
 * A person's PAT carries no `device_id` and resolves to nothing. An agent
 * credential names its box and its project, and those two select the in-flight
 * job with a live session on that box for that project.
 */
// cm:guard more than one match is REFUSED, never picked. The predecessor of this lookup took "the most recently dispatched job on that box" and mis-attributed every tool call on a runner at concurrency 3 (ISS-931); a guess that is right most of the time writes the wrong issue's finding the rest of it, and nothing downstream can tell. ISS-933 makes a run carry a group of issues, so one live run per box-and-project becomes an invariant and this branch stops being reachable — until then a named refusal is the correct answer.
export async function resolvePipelineContext(
  caller: PipelineCaller,
): Promise<PipelineContextResult> {
  if (!caller.deviceId) {
    return {
      ok: false,
      reason: 'not_pipeline_context',
      detail:
        'This call carries a credential that is not issued to a box, so it is running inside no pipeline job. A personal access token is one such credential.',
    };
  }
  if (!caller.boundProjectId) {
    return {
      ok: false,
      reason: 'not_pipeline_context',
      detail:
        'This credential is issued to a box but is not bound to a project, so it names no job. An agent credential is bound to exactly one project.',
    };
  }

  // cm:guard the SESSION is the handle and the job is a LEFT JOIN off it, never the other way round. A steward or schedule run is a session with NO job row (ISS-557), so a job-first lookup drops its attribution entirely and its reports record null everywhere.
  const rows = await db
    .select({
      agentSessionId: agentSessions.id,
      jobId: jobs.id,
      runId: jobs.pipelineRunId,
      issueId: jobs.issueId,
      stage: jobs.type,
      deviceId: agentSessions.deviceId,
    })
    .from(agentSessions)
    .leftJoin(
      jobs,
      and(eq(jobs.agentSessionId, agentSessions.id), inArray(jobs.status, IN_FLIGHT_JOB_STATUSES)),
    )
    .where(
      and(
        eq(agentSessions.deviceId, caller.deviceId),
        eq(agentSessions.projectId, caller.boundProjectId),
        inArray(agentSessions.status, ACTIVE_SESSION_STATUSES),
      ),
    )
    .limit(2);

  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'not_pipeline_context',
      detail:
        'No live agent session is running on this box for this project, so there is nothing to attribute this call to.',
    };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_pipeline_context',
      detail:
        'This box is running more than one session for this project, so the call names no single one. Nothing was written: a guess here attributes the write to the wrong issue and nothing downstream can tell.',
    };
  }
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      reason: 'not_pipeline_context',
      detail: 'No live agent session is running on this box for this project.',
    };
  }
  return { ok: true, context: row };
}
