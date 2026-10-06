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

export async function enqueueJob(
  row: OnboardingRow,
  phase: OnboardingJobPhase,
  createdBy: string,
  extra: { batchId?: string; reason?: string | null; request?: string | null } = {},
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
    promptString:
      phase === 'revise' && extra.batchId
        ? revisePrompt({ ...ctx, batchId: extra.batchId })
        : analysePrompt(ctx),
    payloadExtras: {
      onboardingId: row.id,
      onboardingPhase: phase,
      ...(extra.batchId ? { batchId: extra.batchId } : {}),
      timeoutSeconds: 3600,
    },
  });
  await db.update(onboardings).set({ lastJobId: jobId }).where(eq(onboardings.id, row.id));
  return jobId;
}

/** The agent's last act of a phase settles the job that ran it. */
export async function settlePhaseJob(agency: ActorAgency, jobId: string | null) {
  if (!jobId) return;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (job && settlesPhaseJob(agency, job.status))
    await finalizeJobDone(job, 'onboarding_phase_settled');
}

/** After a submit commits: one revise job reads the answers, unless an onboarding job already runs. */
export async function afterOnboardingSubmit(batch: BatchRow, submittedBy: string) {
  if (!batch.onboardingId) return;
  const row = await onboardingOf(db, batch.projectId);
  if (!row || (await liveJobOf(db, batch.projectId))) return;
  await enqueueJob(row, 'revise', submittedBy, { batchId: batch.id });
}
