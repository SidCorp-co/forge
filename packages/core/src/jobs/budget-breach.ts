/**
 * What happens to a job whose project has spent its month.
 *
 * ISS-823 — the breach is the pipeline waiting on a MACHINE, not on a person,
 * so the shape is a terminal job plus a `held` retry behind it: the issue stays
 * at its stage, the run stays `running`, and nothing is stranded. `held` is
 * slotless by design, which is also what takes the job out of the claim pool
 * instead of leaving it to be re-claimed and re-refused forever.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { CLASSIFIER_VERSION } from '../pipeline/failure-classifier.js';
import { hooks } from '../pipeline/hooks.js';
import { type BudgetCheckResult, postBudgetExhaustedComment } from './budget-check.js';
import { finalizeFailedJob } from './finalize-failure.js';

/**
 * End a claimed job because the monthly cap is reached, leaving the `held`
 * retry that records why.
 */
// cm:guard this must NOT become a plain refusal that leaves the job `queued`. A queued job goes straight back into the pool, so the next master claims it, re-runs the same check and posts the same comment — an issue collecting one operator comment per master pass, and a breach that never comes to rest. `held` is what makes the answer stick.
// cm:edge lockstep -> packages/core/src/devices/claim.ts — the claim calls this and then reports `budget_exhausted`; the reason it returns is for the MASTER's next choice, while the rows written here are the kernel's record. Dropping either half leaves one of the two blind.
export async function endJobForBudgetBreach(
  job: typeof jobs.$inferSelect,
  budget: BudgetCheckResult,
): Promise<void> {
  const [updated] = await applyKernelTransition(db, {
    entity: 'job',
    to: 'failed',
    set: {
      finishedAt: new Date(),
      failureKind: 'code',
      failureAction: 'terminal',
      failureReason: 'monthly_budget_exhausted',
      failureMeta: {
        spent: budget.spent,
        budget: budget.budget,
        stageStatus: budget.stageStatus,
      } as never,
      classifierVersion: CLASSIFIER_VERSION,
    },
    where: and(eq(jobs.id, job.id), eq(jobs.status, 'queued')),
    fromStatus: 'queued',
    reason: 'monthly_budget_exhausted',
    actor: { type: 'system' },
    source: 'claim',
  });

  await hooks.emit('pipeline.budgetBreach', {
    projectId: job.projectId,
    stageStatus: budget.stageStatus ?? '',
    jobType: job.type,
    spent: budget.spent,
    budget: budget.budget ?? 0,
    jobId: job.id,
    issueId: job.issueId,
  });

  if (job.issueId) {
    try {
      await postBudgetExhaustedComment({
        issueId: job.issueId,
        jobType: job.type,
        result: budget,
      });
    } catch (err) {
      logger.warn(
        { err, jobId: job.id, issueId: job.issueId },
        'budget: postBudgetExhaustedComment threw, continuing',
      );
    }
  }

  logger.warn(
    {
      jobId: job.id,
      projectId: job.projectId,
      stageStatus: budget.stageStatus,
      spent: budget.spent,
      budget: budget.budget,
    },
    'budget: monthly budget exhausted, ending job',
  );

  if (updated) {
    try {
      await finalizeFailedJob(updated, {
        error: 'monthly_budget_exhausted',
        precomputedRetry: { scheduled: false, reason: 'monthly_budget_exhausted' },
      });
    } catch (err) {
      logger.error(
        { err, jobId: job.id, issueId: job.issueId },
        'budget: finalizeFailedJob threw after budget breach',
      );
    }
  }
}
