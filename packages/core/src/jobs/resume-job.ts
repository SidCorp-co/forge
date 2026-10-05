import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { publishPipelineHealthChanged } from '../issues/index.js';
import type { KernelActor } from '../lifecycle/index.js';
import { notFound } from '../middleware/route-errors.js';
import { readHoldState, requeueHeldJob } from './hold.js';
import { insertInterventionEvent } from './intervention-event.js';
import { pushJobChanged } from './job-push.js';
import { refuseJob } from './refusals.js';

/**
 * A person releases a hold: the job goes back to `queued` without re-running the hold's check,
 * because the resume IS the override, and the audit row is what makes it reviewable. A hold that
 * does not release itself (retries spent, a non-retryable failure) has only this way out.
 */
export async function resumeHeldJob(
  jobId: string,
  opts: { actorUserId: string; actor: KernelActor; reason: string; source: 'rest' | 'mcp' },
): Promise<{ jobId: string; status: 'queued'; heldReason: string | null }> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw notFound('job not found');
  if (job.status !== 'held') throw refuseJob('NOT_HELD', `job is ${job.status}, not held`);
  const heldReason = readHoldState(job.payload)?.reason ?? job.failureReason ?? null;

  const updated = await db.transaction(async (tx) => {
    const row = await requeueHeldJob(tx, job, {
      actor: opts.actor,
      reason: opts.reason,
      source: `job-resume-${opts.source}`,
    });
    if (!row) return null;
    await insertInterventionEvent(tx, {
      actorUserId: opts.actorUserId,
      reason: opts.reason,
      source: opts.source,
      jobId: row.id,
      issueId: row.issueId,
      previousStatus: 'held',
      action: 'resume',
    });
    return row;
  });
  if (!updated) throw refuseJob('NOT_HELD', 'job state changed mid-request');

  await pushJobChanged({
    projectId: job.projectId,
    jobId: updated.id,
    deviceId: job.deviceId,
    event: 'job.resumed',
    data: { jobId: updated.id, status: 'queued' },
    rooms: ['project'],
  });
  if (updated.issueId) await publishPipelineHealthChanged(job.projectId, [updated.issueId]);
  return { jobId: updated.id, status: 'queued', heldReason };
}
