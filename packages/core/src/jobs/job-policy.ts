import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type jobs } from '../db/schema.js';
import {
  type DispatchState,
  dispatchStateOf,
  requirePolicy,
} from '../project-config/dispatch-policy.js';

/** The status the job's creator stamped as the one it runs for, or null. */
export function extractStageStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>).stageStatus;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

type PolicyJob = Pick<typeof jobs.$inferSelect, 'projectId' | 'issueId' | 'payload'>;

/**
 * The policy state a job runs under, from the project's policy-v1 alone.
 *
 * Throws a policy refusal (`policyRefusal`) when the project has no policy, or its policy leaves out the state
 * the job is for; the caller refuses the claim by that name.
 */
export async function resolveJobPolicy(job: PolicyJob): Promise<DispatchState> {
  const held = await requirePolicy(job.projectId);
  const stamped = extractStageStatus(job.payload);
  if (stamped !== null) {
    return dispatchStateOf(job.projectId, held, { status: stamped, from: 'stamped' });
  }
  if (job.issueId === null) {
    return dispatchStateOf(job.projectId, held, { status: null, from: 'issue' });
  }
  const [issue] = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, job.issueId))
    .limit(1);
  return dispatchStateOf(job.projectId, held, { status: issue?.status ?? null, from: 'issue' });
}
