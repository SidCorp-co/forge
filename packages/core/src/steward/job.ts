// A steward act that needs the codebase or the running build (REQ-48 BC-4, BC-10) runs as one
// issue-less runner job of type `steward`, templated on the onboarding job: its prompt is the act's
// method, so the runner never branches on the type. The steward account's token is minted when a box
// claims the job and handed in the brief, never stored with the job; it is revoked when the job ends.
// Where no runner is bound the run ends failed naming it: it never falls back to a gateway guess.

import { LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import { STEWARD_ACTS, type StewardAct } from '@forge/contracts/steward';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { revokePat } from '../credentials/pat.js';
import { db } from '../db/client.js';
import { jobs, personalAccessTokens, runners } from '../db/schema.js';
import { env } from '../lib/env.js';
import { insertAndEnqueueJob, openOneShotRun } from '../pipeline/index.js';
import { stewardAccountOf } from './account.js';
import { mintStewardCredential } from './credential.js';
import { actContext, actPrompt } from './prompts.js';
import type { RunRow } from './runs-store.js';

/** The job's own limit, and its token's life past it. */
const JOB_TIMEOUT_SECONDS = 3600;
const JOB_TOKEN_TTL_MS = (JOB_TIMEOUT_SECONDS + 10 * 60) * 1000;

export type JobStart = { ok: true; jobId: string } | { ok: false; failure: string };

async function runnerBound(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(eq(runners.projectId, projectId))
    .limit(1);
  return row !== undefined;
}

/** Whether the project already has a steward job live: one at a time per project (cost guard). */
export async function stewardJobLive(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        eq(jobs.type, 'steward'),
        inArray(jobs.status, [...LIVE_JOB_STATUSES]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

function brief(run: RunRow, acts: readonly StewardAct[]): string {
  return [
    ...acts.map((a) => actPrompt(a)),
    actContext(run, null),
    `Project id: ${run.projectId}. Steward run: ${run.id}.`,
  ].join('\n\n');
}

/** Queue the run's runner acts as one steward job, or say why none can run. */
export async function enqueueStewardJob(
  run: RunRow,
  acts: readonly StewardAct[],
): Promise<JobStart> {
  if (!(await runnerBound(run.projectId))) {
    return {
      ok: false,
      failure: `no runner is bound to this project, so ${acts.join(' and ')} on ${run.subjectKey} cannot run; it needs the codebase and the running build, and is never guessed on the gateway instead`,
    };
  }
  const stewardId = await stewardAccountOf(run.projectId);
  const pipelineRun = await openOneShotRun({
    projectId: run.projectId,
    kind: 'system',
    metadata: { source: 'steward', stewardRunId: run.id, acts: [...acts] },
  });
  const { jobId } = await insertAndEnqueueJob({
    projectId: run.projectId,
    issueId: null,
    pipelineRunId: pipelineRun.id,
    createdBy: stewardId,
    type: 'steward',
    skillName: `steward-${acts.join('-')}`,
    promptString: brief(run, acts),
    payloadExtras: {
      stewardRunId: run.id,
      stewardActs: [...acts],
      timeoutSeconds: JOB_TIMEOUT_SECONDS,
    },
  });
  return { ok: true, jobId };
}

const jobTokenName = (jobId: string) => `steward job ${jobId}`;

/** The acts a steward job was enqueued for, which its token's approvals follow; a job naming none is refused. */
function jobActsOf(job: { id: string; payload: unknown }): StewardAct[] {
  const named = (job.payload as { stewardActs?: unknown } | null)?.stewardActs;
  const acts = Array.isArray(named) ? STEWARD_ACTS.filter((a) => named.includes(a)) : [];
  if (acts.length === 0 || !Array.isArray(named) || acts.length !== named.length) {
    throw new Error(
      `steward: job ${job.id} names no steward acts its token can be minted for (payload.stewardActs is ${JSON.stringify(named)})`,
    );
  }
  return acts;
}

/**
 * The credential section a claimed steward job's brief ends with: the steward account's token for
 * this job, minted now and named for the job so its end revokes it.
 */
export async function stewardJobCredential(job: {
  id: string;
  projectId: string;
  payload: unknown;
}): Promise<string> {
  const stewardId = await stewardAccountOf(job.projectId);
  const credential = await mintStewardCredential({
    projectId: job.projectId,
    stewardId,
    acts: jobActsOf(job),
    ttlMs: JOB_TOKEN_TTL_MS,
    name: jobTokenName(job.id),
  });
  const base = env.PUBLIC_API_BASE_URL ?? env.APP_BASE_URL;
  return [
    "You act as this project's steward account, not as this box. Make every Forge call this act names over HTTP:",
    `  curl -sS -H "Authorization: Bearer ${credential.token}" -H 'content-type: application/json' ${base}/api/...`,
    "The token reaches this project alone, holds only the steward's grants, and is revoked when this job ends. Never write it anywhere.",
  ].join('\n');
}

/** Revoke the job's steward token, if it is still live. */
export async function revokeJobCredential(projectId: string, jobId: string): Promise<void> {
  const stewardId = await stewardAccountOf(projectId);
  const live = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.userId, stewardId),
        eq(personalAccessTokens.name, jobTokenName(jobId)),
        isNull(personalAccessTokens.revokedAt),
      ),
    );
  for (const row of live) await revokePat(row.id, stewardId);
}
