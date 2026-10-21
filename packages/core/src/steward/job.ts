// A steward act that needs the codebase or the running build (REQ-48 BC-4, BC-10) runs as one
// issue-less runner job of type `steward`, templated on the onboarding job: its prompt is the act's
// method, so the runner never branches on the type. The steward account's token is minted when a box
// claims the job and handed in the brief, never stored with the job; it is revoked when the job ends.
// Where no runner is bound the run ends failed naming it: it never falls back to a gateway guess.

import { LIVE_JOB_STATUSES, OCCUPYING_JOB_STATUSES } from '@forge/contracts/job-machine';
import { STEWARD_ACTS, type StewardAct, type StewardRefusalCode } from '@forge/contracts/steward';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { revokePat } from '../credentials/pat.js';
import { db } from '../db/client.js';
import { jobs, personalAccessTokens, runners } from '../db/schema.js';
import { finalizeJobDone } from '../jobs/index.js';
import { env } from '../lib/env.js';
import { refuser } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { insertAndEnqueueJob, openOneShotRun } from '../pipeline/index.js';
import { stewardAccountOf } from './account.js';
import { mintStewardCredential } from './credential.js';
import { actContext, actPrompt } from './prompts.js';
import { endRun, type RunRow, runOfProject } from './runs-store.js';

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

/** The job's last act: the door that settles it, named with its body, so the job never ends unsettled. */
export const jobDoneStep = (run: RunRow) =>
  [
    `Your last act, whatever happened: \`POST /api/projects/${run.projectId}/steward-runs/${run.id}/done\` with \`{"refused": []}\`.`,
    'Name in `refused` each write a door refused (a 4xx), as `METHOD path: CODE detail`, and in `broken` each a door could not answer (a 5xx); leave both empty where every write landed.',
    'This is what ends the job. Without it the box reads a finished agent as a failed job a quarter hour later, and the run fails with it.',
  ].join('\n');

function brief(run: RunRow, acts: readonly StewardAct[]): string {
  return [
    ...acts.map((a) => actPrompt(a)),
    actContext(run, null),
    `Project id: ${run.projectId}. Steward run: ${run.id}.`,
    jobDoneStep(run),
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

/**
 * A steward job that ended holds no live token, whatever ended it: the job's own transition
 * delivers this, and a failed delivery is retried, so a revoke a done call lost still lands.
 */
export async function revokeEndedJobCredential(projectId: string, jobId: string): Promise<void> {
  const [job] = await db.select({ type: jobs.type }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (job?.type === 'steward') await revokeJobCredential(projectId, jobId);
}

const refuse = refuser<StewardRefusalCode>('STEWARD_RUN_UNKNOWN');

/**
 * A steward job's last act (REQ-48 BC-1): the steward account says its acts are over, and which
 * writes a door refused or could not answer. The run ends `done`, or `failed` naming each (a refused
 * act waits for the standing to move, a broken one is tried again), the job is settled done so the
 * box never reads the quiet pane as a failed job, and its token is revoked last. A call that finds
 * the run ended and its job still live settles the job, so a settlement cut short is finished by
 * the retry. Only the project's steward settles its own run.
 */
export async function finishStewardJob(input: {
  projectId: string;
  runId: string;
  userId: string;
  refused: readonly string[];
  broken?: readonly string[];
}): Promise<'done' | 'failed'> {
  await requireCan(actorFor(input.userId), 'project.read', projectResource(input.projectId));
  const stewardId = await stewardAccountOf(input.projectId);
  if (input.userId !== stewardId) {
    throw refuse(
      'STEWARD_RUN_FORBIDDEN',
      "a steward run's job is settled by the project's steward account alone.",
    );
  }
  const run = await runOfProject(input.projectId, input.runId);
  const [job] = run?.jobId
    ? await db.select().from(jobs).where(eq(jobs.id, run.jobId)).limit(1)
    : [];
  if (!run)
    throw refuse('STEWARD_RUN_UNKNOWN', `no steward run ${input.runId} in this project`, '/runId');
  const jobLive =
    job !== undefined && (OCCUPYING_JOB_STATUSES as readonly string[]).includes(job.status);
  const ended = run.state === 'done' || run.state === 'failed';
  if (!job || !(run.state === 'running' || (ended && jobLive))) {
    throw refuse(
      'STEWARD_RUN_NOT_JOB',
      `steward run ${run.id} is ${run.state}${job ? '' : ' with no job'}; only a running run's own job settles it.`,
      '/runId',
    );
  }
  let state: 'done' | 'failed' = run.state === 'failed' ? 'failed' : 'done';
  if (run.state === 'running') {
    const acts = run.actsToRun.join(', ');
    const failures = [
      ...input.refused.map((r) => `${acts}: the door refused ${r}`),
      ...(input.broken ?? []).map((r) => `${acts}: the door broke ${r}`),
    ];
    state = failures.length > 0 ? 'failed' : 'done';
    await endRun(
      run.id,
      state === 'failed'
        ? {
            state,
            failure: failures.join('\n'),
            kind: (input.broken ?? []).length > 0 ? 'error' : 'refused',
          }
        : { state },
    );
  }
  if (jobLive) await finalizeJobDone(job, 'steward_run_settled');
  await revokeJobCredential(input.projectId, job.id);
  return state;
}
