// Stopping what a project's runs left live when it is archived (ISS-1449): its own cancel, job by
// job, so a queued job never dispatches and a dispatched one is asked to stop by its runner.

import { LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { cancelJob } from './cancel-job.js';

/** Cancel each live job of the project as `userId`; the ids it stopped. */
export async function stopProjectJobs(args: {
  projectId: string;
  userId: string;
  agency: ActorAgency;
  reason: string;
}): Promise<string[]> {
  const live = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.projectId, args.projectId), inArray(jobs.status, [...LIVE_JOB_STATUSES])));
  const stopped: string[] = [];
  for (const job of live) {
    const out = await cancelJob(job.id, {
      actorUserId: args.userId,
      actorAgency: args.agency,
      reason: args.reason,
      source: 'rest',
    });
    stopped.push(out.jobId);
  }
  return stopped;
}
