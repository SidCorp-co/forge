import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { issueStepContexts, jobs, pipelineRuns } from '../../db/schema.js';

export interface JobRow {
  id: string;
  type: string;
  status: string;
  failureKind: string | null;
  failureReason: string | null;
  queuedAt: Date;
  finishedAt: Date | null;
}

export interface RunRow {
  id: string;
  issueId: string | null;
  status: string;
  startedAt: Date;
}

export interface HandoffRow {
  step: string | null;
  attempt: number;
  payload: unknown;
  createdAt: Date;
}

/** Jobs for a specific pipeline run, ordered by creation time. */
export async function getJobsForRun(runId: string): Promise<JobRow[]> {
  return db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      failureKind: jobs.failureKind,
      failureReason: jobs.failureReason,
      queuedAt: jobs.queuedAt,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs)
    .where(eq(jobs.pipelineRunId, runId))
    .orderBy(jobs.queuedAt);
}

/** All terminal pipeline runs for an issue (completed/failed/cancelled), ordered newest-first. */
export async function getRunsForIssue(issueId: string): Promise<RunRow[]> {
  return db
    .select({
      id: pipelineRuns.id,
      issueId: pipelineRuns.issueId,
      status: pipelineRuns.status,
      startedAt: pipelineRuns.startedAt,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.issueId, issueId),
        sql`${pipelineRuns.status} IN ('completed','failed','cancelled')`,
      ),
    )
    .orderBy(desc(pipelineRuns.startedAt));
}

/** Fix-type jobs across the whole project (last 90 days). */
export async function getProjectFixJobs(
  projectId: string,
): Promise<Array<JobRow & { issueId: string | null; runId: string }>> {
  return db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      failureKind: jobs.failureKind,
      failureReason: jobs.failureReason,
      queuedAt: jobs.queuedAt,
      finishedAt: jobs.finishedAt,
      issueId: jobs.issueId,
      runId: jobs.pipelineRunId,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        eq(jobs.type, 'fix'),
        isNotNull(jobs.failureKind),
        sql`${jobs.queuedAt} > now() - interval '90 days'`,
      ),
    )
    .orderBy(desc(jobs.queuedAt));
}

/** Step handoffs for an issue's pipeline run, ordered by creation time. */
export async function getHandoffsForRun(runId: string): Promise<HandoffRow[]> {
  return db
    .select({
      step: issueStepContexts.step,
      attempt: issueStepContexts.attempt,
      payload: issueStepContexts.payload,
      createdAt: issueStepContexts.createdAt,
    })
    .from(issueStepContexts)
    .where(
      and(
        eq(issueStepContexts.pipelineRunId, runId),
        sql`${issueStepContexts.kind} = 'handoff'`,
      ),
    )
    .orderBy(issueStepContexts.createdAt);
}
