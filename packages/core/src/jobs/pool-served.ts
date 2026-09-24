/**
 * A pool job is briefed with its own `payload.promptString` and nothing else
 * (`prepare-claimed-job.ts:prepareClaimedJob`); a box hands back a job without
 * one on every pass, so it heads its project's pool forever. Lanes that cannot
 * supply one are refused where they would mint, and such a row that reached the
 * pool anyway is refused and settled at the claim.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { CLASSIFIER_VERSION } from '../pipeline/failure-classifier.js';
import { failReconcileRunForFailedJob } from '../skills/reconcile-service.js';

export const POOL_JOB_NO_PROMPT = 'POOL_JOB_NO_PROMPT';

export function poolPrompt(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as { promptString?: unknown }).promptString;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function noPromptMessage(jobType: string): string {
  return (
    `a \`${jobType}\` job carries no prompt, and the job pool runs only the ` +
    '`payload.promptString` a job is minted with — a box given this job hands it back on ' +
    'every pass. Mint it with a non-empty `promptString`, or not at all.'
  );
}

const NO_PROMPT_SQL = sql`NOT COALESCE(
  jsonb_typeof(${jobs.payload} -> 'promptString') = 'string'
    AND (${jobs.payload} ->> 'promptString') ~ '[^[:space:]]',
  false
)`;

/**
 * Terminal, and not through `finalizeFailedJob`, whose retry or hold would re-mint the payload.
 * The CAS re-checks the missing prompt, so `false` when the row moved or gained one.
 */
export async function settleNoPromptJob(job: { id: string; type: string }): Promise<boolean> {
  const [settled] = await applyKernelTransition(db, {
    entity: 'job',
    to: 'failed',
    set: {
      finishedAt: new Date(),
      error: noPromptMessage(job.type),
      failureKind: 'code',
      failureAction: 'terminal',
      failureReason: POOL_JOB_NO_PROMPT,
      classifierVersion: CLASSIFIER_VERSION,
    },
    where: and(eq(jobs.id, job.id), eq(jobs.status, 'queued'), isNull(jobs.heldBy), NO_PROMPT_SQL),
    fromStatus: 'queued',
    reason: POOL_JOB_NO_PROMPT,
    actor: { type: 'system' },
    source: 'claim',
    returning: ['id', 'type', 'payload'],
  });
  if (!settled) return false;
  logger.error(
    { jobId: job.id, jobType: job.type, code: POOL_JOB_NO_PROMPT },
    'pool: a job with no prompt was refused at the claim and settled failed',
  );
  await failReconcileRunForFailedJob(settled);
  return true;
}
