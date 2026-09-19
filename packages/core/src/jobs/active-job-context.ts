import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';

const IN_FLIGHT_JOB_STATUSES = ['dispatched', 'running'] as const;

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
