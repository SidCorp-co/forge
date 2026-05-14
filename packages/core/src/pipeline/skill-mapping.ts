import { eq } from 'drizzle-orm';
import type { IssueStatus, JobType } from '../db/schema.js';
import { STATUS_TO_JOB_TYPE, type JobTypeMapping } from './registry.js';

export type { JobTypeMapping } from './registry.js';
export { STATUS_TO_JOB_TYPE } from './registry.js';

export interface ResolvedSkill extends JobTypeMapping {
  skillName: string;
}

export function resolveJobTypeForStatus(status: IssueStatus): JobTypeMapping | null {
  return STATUS_TO_JOB_TYPE[status] ?? null;
}

const JOB_TYPE_TO_STATUS: Partial<Record<JobType, IssueStatus>> = (() => {
  const out: Partial<Record<JobType, IssueStatus>> = {};
  for (const [status, mapping] of Object.entries(STATUS_TO_JOB_TYPE)) {
    if (mapping) out[mapping.type] = status as IssueStatus;
  }
  return out;
})();

export function inverseJobTypeToStatus(jobType: JobType): IssueStatus | null {
  return JOB_TYPE_TO_STATUS[jobType] ?? null;
}

export interface ProjectSkillResolver {
  resolve(status: IssueStatus): Promise<ResolvedSkill | null>;
}

/**
 * Per-project skill resolver. Lazy-batches all `skill_registrations` rows for
 * the project on first call and memoizes them by stage. One instance per
 * dispatch call site is enough — each call enqueues at most one job, and the
 * resolver can be reused across the same `pipeline_run` if a batch caller
 * eventually wants that.
 */
export function createProjectSkillResolver(projectId: string): ProjectSkillResolver {
  let loaded: Promise<Map<string, string>> | null = null;

  const load = (): Promise<Map<string, string>> => {
    if (!loaded) {
      // Lazy-imported so consumers that only need the synchronous helpers
      // (resolveJobTypeForStatus, inverseJobTypeToStatus) don't pay the cost
      // of evaluating the env validator at module load.
      loaded = (async () => {
        const { db } = await import('../db/client.js');
        const { skillRegistrations, skills } = await import('../db/schema.js');
        const rows = await db
          .select({ stage: skillRegistrations.stage, name: skills.name })
          .from(skillRegistrations)
          .innerJoin(skills, eq(skills.id, skillRegistrations.skillId))
          .where(eq(skillRegistrations.projectId, projectId));
        return new Map(rows.map((r) => [r.stage, r.name]));
      })();
    }
    return loaded;
  };

  return {
    async resolve(status: IssueStatus): Promise<ResolvedSkill | null> {
      const jobMap = STATUS_TO_JOB_TYPE[status];
      if (!jobMap) return null;
      const stageMap = await load();
      const skillName = stageMap.get(status);
      if (!skillName) return null;
      return { type: jobMap.type, toggle: jobMap.toggle, skillName };
    },
  };
}

export async function resolveSkillForStatus(
  status: IssueStatus,
  projectId: string,
): Promise<ResolvedSkill | null> {
  return createProjectSkillResolver(projectId).resolve(status);
}
