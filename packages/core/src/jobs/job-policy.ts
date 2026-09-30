import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type jobs } from '../db/schema.js';
import {
  type DispatchState,
  dispatchStateOf,
  requirePolicy,
} from '../project-config/dispatch-policy.js';

export const SKILL_MAINTENANCE_LABEL = 'skill-maintenance';

export const SKILL_MAINTENANCE_TOOLS = [
  'mcp__forge__forge_skills_update',
  'mcp__forge__forge_skills_push',
  'mcp__forge__forge_skills_sync_status',
] as const;

/** The deny list a skill-maintenance `code`/`fix` job runs with: its policy's, minus the skill-write tools. */
export function withSkillMaintenanceCarveout(
  deniedTools: readonly string[],
  opts: { hasSkillMaintenanceLabel: boolean; jobType: string },
): string[] {
  if (!opts.hasSkillMaintenanceLabel) return [...deniedTools];
  if (opts.jobType !== 'code' && opts.jobType !== 'fix') return [...deniedTools];
  return deniedTools.filter(
    (t) => !SKILL_MAINTENANCE_TOOLS.includes(t as (typeof SKILL_MAINTENANCE_TOOLS)[number]),
  );
}

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
 * Throws `PolicyRefusedError` when the project has no policy, or its policy leaves out the state
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
