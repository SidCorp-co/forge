import { JOB_MACHINE } from '@forge/contracts/job-machine';
import { noPromptMessage, POOL_JOB_NO_PROMPT } from '@forge/contracts/jobs';
/**
 * A pool job is briefed with its own `payload.promptString`, headed only by who dispatched it
 * (`prepare-claimed-job.ts:prepareClaimedJob`, `dispatch-header.ts:renderDispatchHeader`); its
 * system prompt reaches the pane on a resume alone. A box hands back a job without
 * one on every pass, so it heads its project's pool forever. Lanes that cannot
 * supply one are refused where they would mint, and such a row that reached the
 * pool anyway is refused and settled at the claim.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { transition } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import { CLASSIFIER_VERSION } from '../pipeline/index.js';
import { syncAgentSessionLifecycle } from './agent-session-link.js';

export { noPromptMessage, POOL_JOB_NO_PROMPT } from '@forge/contracts/jobs';

export function poolPrompt(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as { promptString?: unknown }).promptString;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
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
  const [settled] = (
    await transition(db, JOB_MACHINE, {
      to: 'failed',
      set: {
        finishedAt: new Date(),
        error: noPromptMessage(job.type),
        failureKind: 'code',
        failureAction: 'terminal',
        failureReason: POOL_JOB_NO_PROMPT,
        classifierVersion: CLASSIFIER_VERSION,
      },
      where: and(
        eq(jobs.id, job.id),
        eq(jobs.status, 'queued'),
        isNull(jobs.heldBy),
        NO_PROMPT_SQL,
      ),
      reason: POOL_JOB_NO_PROMPT,
      actor: { type: 'system' },
      source: 'claim',
    })
  ).rows;
  if (!settled) return false;
  logger.error(
    { jobId: job.id, jobType: job.type, code: POOL_JOB_NO_PROMPT },
    'pool: a job with no prompt was refused at the claim and settled failed',
  );
  // the publish finalizeFailedJob ends with, without its retry or hold: there is nothing to retry
  await syncAgentSessionLifecycle(settled, 'failed');
  await emitEvent(db, 'job.changed', {
    projectId: settled.projectId,
    jobId: settled.id,
    deviceId: settled.deviceId,
    event: 'job.failed',
    data: { jobId: settled.id, status: 'failed', exitCode: settled.exitCode, error: settled.error },
    rooms: ['project'],
  });
  if (settled.issueId) await publishPipelineHealthChanged(settled.projectId, [settled.issueId]);
  return true;
}
