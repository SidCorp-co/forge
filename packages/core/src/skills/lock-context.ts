// The project half of the skill lock: reads `agentConfig.pipelineConfig` and hands `lock.ts` the declaration it evaluates. It lives beside the resolver rather than in `service.ts` so the pure rules stay unit-testable with no database in scope.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { readStoredPipelineConfig } from '../pipeline/stored-pipeline-config.js';
import {
  type LockedSkillsDeclaration,
  readLockedSkills,
  SkillLockedError,
  skillLockReason,
} from './lock.js';
import { isMetaSkillName, MetaSkillReservedError } from './meta-skills.js';

export interface ProjectLockContext {
  declared: LockedSkillsDeclaration;
}

/**
 * Locks declared by the project. Forge-reserved names do not need this lookup — they are locked everywhere — so a project that declares nothing degrades to reservation-only rather than blocking the write.
 */
export async function projectLockContext(projectId: string): Promise<ProjectLockContext> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const stored = (row?.agentConfig as { pipelineConfig?: unknown } | null)?.pipelineConfig;
  return { declared: readLockedSkills(readStoredPipelineConfig(projectId, stored)) };
}

/**
 * Throw if `name` may not be created or adopted on this project.
 */
export async function assertSkillNameWritable(name: string, projectId: string): Promise<void> {
  if (isMetaSkillName(name)) throw new MetaSkillReservedError(name);
  const reason = skillLockReason(name, await projectLockContext(projectId));
  if (reason) throw new SkillLockedError(name, reason);
}
