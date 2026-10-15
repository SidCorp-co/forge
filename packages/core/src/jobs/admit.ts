import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { jobs, pipelineRuns } from '../db/schema.js';
import { openIssueRun } from '../pipeline/runs.js';

type NewJob = typeof jobs.$inferInsert;
type JobRow = typeof jobs.$inferSelect;

const OPEN_RUN_STATUSES = ['running', 'paused'];

/** A job was refused a run that is no longer open; it is never written under one. */
export class RunClosedToJobs extends Error {
  readonly code = 'RUN_CLOSED';
  constructor(
    readonly runId: string,
    readonly runStatus: string | null,
  ) {
    super(
      runStatus === null
        ? `run ${runId} does not exist, so no job is admitted to it`
        : `run ${runId} is ${runStatus}, so no job is admitted to it; only a running or paused run takes one`,
    );
    this.name = 'RunClosedToJobs';
  }
}

/**
 * The one door a job reaches a run by. The run row is taken `FOR SHARE` in the insert's own
 * transaction (a savepoint on an open one), and every close's UPDATE conflicts with that lock: a
 * close either commits first and this refuses the run, or waits until the job is written.
 */
export async function admitJob(executor: Tx, values: NewJob): Promise<JobRow> {
  return executor.transaction(async (tx) => {
    const [run] = await tx.execute<{ status: string }>(
      sql`SELECT ${pipelineRuns.status} AS status FROM ${pipelineRuns}
           WHERE ${pipelineRuns.id} = ${values.pipelineRunId} FOR SHARE`,
    );
    if (!run || !OPEN_RUN_STATUSES.includes(run.status)) {
      throw new RunClosedToJobs(values.pipelineRunId, run?.status ?? null);
    }
    const [row] = await tx.insert(jobs).values(values).returning();
    if (!row) throw new Error('jobs: insert returned no row');
    return row;
  });
}

/** How many times the issue door re-reads the issue's open run after a close took the one it read. */
const REOPEN_ATTEMPTS = 3;

/**
 * Admit a job to the issue's open run, opening one where none is. A close that ends the run between
 * the read and the admission makes `openIssueRun` open a fresh run on the next pass.
 */
export async function admitIssueJob(
  executor: Tx,
  values: Omit<NewJob, 'pipelineRunId'> & { projectId: string; issueId: string },
): Promise<JobRow> {
  let refused: RunClosedToJobs | null = null;
  for (let attempt = 0; attempt < REOPEN_ATTEMPTS; attempt++) {
    const run = await openIssueRun({ projectId: values.projectId, issueId: values.issueId });
    try {
      return await admitJob(executor, { ...values, pipelineRunId: run.id });
    } catch (err) {
      if (!(err instanceof RunClosedToJobs)) throw err;
      refused = err;
    }
  }
  throw refused ?? new Error('admitIssueJob: no attempt was made');
}
