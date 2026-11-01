/**
 * The one job of an onboarding phase: an issue-less one-shot run whose prompt is the method, queued
 * by a start, a re-analysis or a submitted batch, and settled by the agent's last act of the phase.
 */

import type { OnboardingJobPhase } from '@forge/contracts/onboarding';
import type { ActorAgency } from '@forge/contracts/permissions';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, projects } from '../db/schema.js';
import { onboardings } from '../db/schema-onboarding.js';
import { finalizeJobDone } from '../jobs/index.js';
import { insertAndEnqueueJob, openOneShotRun } from '../pipeline/index.js';
import { readDeclaredSource } from '../project-config/index.js';
import type { BatchRow } from '../questionnaires/index.js';
import { analysePrompt, type OnboardingPromptContext, revisePrompt } from './prompt.js';
import { liveJobOf, type OnboardingRow, onboardingOf, projectHoldsSensitiveData } from './read.js';
import { settlesPhaseJob } from './rules.js';

type PhaseExtra = { batchId?: string; reason?: string | null; request?: string | null };

/** The method a phase's job runs, written from the onboarding and its project as they stand now. */
async function phaseBrief(
  row: OnboardingRow,
  phase: OnboardingJobPhase,
  extra: PhaseExtra,
): Promise<string> {
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, row.projectId));
  const source = await readDeclaredSource(row.projectId);
  const ctx: OnboardingPromptContext = {
    projectId: row.projectId,
    projectName: project?.name ?? row.projectId,
    onboardingId: row.id,
    conversationId: row.conversationId,
    sensitiveData: await projectHoldsSensitiveData(row.projectId),
    repository: source.repository,
    defaultBranch: source.defaultBranch,
    roundsSent: row.roundsSent,
    reason: extra.reason ?? null,
    request: extra.request ?? null,
  };
  return phase === 'revise' && extra.batchId
    ? revisePrompt({ ...ctx, batchId: extra.batchId })
    : analysePrompt(ctx);
}

export async function enqueueJob(
  row: OnboardingRow,
  phase: OnboardingJobPhase,
  createdBy: string,
  extra: PhaseExtra = {},
): Promise<string> {
  const run = await openOneShotRun({
    projectId: row.projectId,
    kind: 'system',
    metadata: { source: 'onboarding', onboardingId: row.id, phase },
  });
  const { jobId } = await insertAndEnqueueJob({
    projectId: row.projectId,
    issueId: null,
    pipelineRunId: run.id,
    createdBy,
    type: 'onboarding',
    skillName: `onboarding-${phase}`,
    promptString: await phaseBrief(row, phase, extra),
    payloadExtras: {
      onboardingId: row.id,
      onboardingPhase: phase,
      ...(extra.batchId ? { batchId: extra.batchId } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.request ? { request: extra.request } : {}),
      timeoutSeconds: 3600,
    },
  });
  await db.update(onboardings).set({ lastJobId: jobId }).where(eq(onboardings.id, row.id));
  return jobId;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * An onboarding job's brief at its claim (ISS-865): the method as core writes it now, for the
 * onboarding and phase its payload names. A job queued before the method changed, and every retry of
 * it (a retry copies its payload), would otherwise run the brief it was first queued with: forge's
 * revise job 1779f21f named MCP tools removed hours before it ran (9181ac9b1), its agent ended with no
 * tool to call, and all ten attempts replayed the same brief. A payload naming no onboarding of this
 * project keeps the brief it carries.
 */
export async function currentOnboardingBrief(job: {
  type: string;
  projectId: string;
  payload: unknown;
}): Promise<string | null> {
  if (job.type !== 'onboarding') return null;
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const row = await onboardingOf(db, job.projectId);
  if (!row || row.id !== payload.onboardingId) return null;
  // a job queued before its phase was carried names it only by its skill (`onboarding-revise`)
  const phase: OnboardingJobPhase =
    payload.onboardingPhase === 'revise' || payload.skillName === 'onboarding-revise'
      ? 'revise'
      : 'analyse';
  const batchId = text(payload.batchId);
  return phaseBrief(row, phase, {
    ...(batchId ? { batchId } : {}),
    reason: text(payload.reason) ?? null,
    request: text(payload.request) ?? null,
  });
}

/**
 * The agent's last act of a phase settles the job that ran it: the newest attempt of the chain
 * `last_job_id` starts. A pool retry is a new job (`jobs.retry_of`) and `last_job_id` keeps naming
 * the first, so settling that one left the running attempt dispatched until the stall check failed
 * it and retried a finished phase (FB-468).
 */
export async function settlePhaseJob(agency: ActorAgency, jobId: string | null) {
  if (!jobId) return;
  let [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  for (let hop = 0; job && hop < MAX_RETRY_HOPS; hop++) {
    const [next] = await db.select().from(jobs).where(eq(jobs.retryOf, job.id));
    if (!next) break;
    job = next;
  }
  if (job && settlesPhaseJob(agency, job.status))
    await finalizeJobDone(job, 'onboarding_phase_settled');
}

/** A bound on following a retry chain; the pool retries a job at most 30 times. */
const MAX_RETRY_HOPS = 64;

/** After a submit commits: one revise job reads the answers, unless an onboarding job already runs. */
export async function afterOnboardingSubmit(batch: BatchRow, submittedBy: string) {
  if (!batch.onboardingId) return;
  const row = await onboardingOf(db, batch.projectId);
  if (!row || (await liveJobOf(db, batch.projectId))) return;
  await enqueueJob(row, 'revise', submittedBy, { batchId: batch.id });
}
