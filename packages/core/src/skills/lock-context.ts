// The project half of the skill lock: reads `agentConfig.pipelineConfig` and
// hands `lock.ts` the declaration it evaluates.
//
// It lives beside the resolver rather than in `service.ts` so the pure rules
// stay unit-testable with no database in scope.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
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
 * Locks declared by the project. Forge-reserved names do not need this lookup —
 * they are locked everywhere — so a project that declares nothing degrades to
 * reservation-only rather than blocking the write.
 */
export async function projectLockContext(projectId: string): Promise<ProjectLockContext> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const agentConfig = row?.agentConfig as Record<string, unknown> | undefined;
  const cfg = agentConfig?.pipelineConfig as Record<string, unknown> | undefined;
  return { declared: readLockedSkills(cfg) };
}

/**
 * Throw if `name` may not be created or adopted on this project. Callers that
 * legitimately install a Forge-owned skill pass `allowReserved`.
 */
// cm:guard the reserved check runs BEFORE the project lookup, so the two errors stay distinguishable: a Forge-owned name is rejected as META_SKILL_RESERVED whatever the project declares, and a project that declares nothing never pays for a read
export async function assertSkillNameWritable(name: string, projectId: string): Promise<void> {
  if (isMetaSkillName(name)) throw new MetaSkillReservedError(name);
  const reason = skillLockReason(name, await projectLockContext(projectId));
  if (reason) throw new SkillLockedError(name, reason);
}
