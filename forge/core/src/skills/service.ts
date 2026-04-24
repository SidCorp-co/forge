import { and, eq, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, skillRegistrations, skills } from '../db/schema.js';

/**
 * Pure-ish helpers shared between the F2 REST routes and the F4 MCP tools.
 * None of these check authorization — callers must verify membership/role
 * before invoking.
 */

export type SkillRow = {
  id: string;
  name: string;
  description: string;
  scope: 'global' | 'project';
  projectId: string | null;
  prompt: string;
  tools: unknown;
  version: number;
  contentHash: string;
};

/**
 * List all skills visible to a project: its own project-scoped skills plus
 * every global skill. Ordered by scope then name — result shape matches the
 * `forge_skills.list` MCP tool and the REST list endpoint.
 */
export async function listProjectSkills(projectId: string): Promise<SkillRow[]> {
  return db
    .select({
      id: skills.id,
      name: skills.name,
      description: skills.description,
      scope: skills.scope,
      projectId: skills.projectId,
      prompt: skills.prompt,
      tools: skills.tools,
      version: skills.version,
      contentHash: skills.contentHash,
    })
    .from(skills)
    .where(or(eq(skills.scope, 'global'), eq(skills.projectId, projectId)))
    .orderBy(skills.scope, skills.name) as Promise<SkillRow[]>;
}

/**
 * Fetch a skill by id, but only return it if it is either global or scoped
 * to the caller's project. Returns null for cross-project skills so the
 * caller sees the same "not found" response either way (no information
 * leak on id existence).
 */
export async function getSkillForProject(
  skillId: string,
  projectId: string,
): Promise<SkillRow | null> {
  const [row] = (await db
    .select({
      id: skills.id,
      name: skills.name,
      description: skills.description,
      scope: skills.scope,
      projectId: skills.projectId,
      prompt: skills.prompt,
      tools: skills.tools,
      version: skills.version,
      contentHash: skills.contentHash,
    })
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1)) as SkillRow[];
  if (!row) return null;
  if (row.scope === 'project' && row.projectId !== projectId) return null;
  return row;
}

/**
 * Bind (or clear) a skill to a pipeline stage for a project. Matches the F2
 * REST behaviour: atomic upsert on `(projectId, stage)` then remove any
 * other stage rows this skill previously held (one-stage-per-skill rule).
 *
 * Returns the resulting registration (or null stage when cleared).
 */
export interface RegisterSkillInput {
  projectId: string;
  skillId: string;
  stage: IssueStatus | null;
  actorUserId: string;
}

export interface RegisterSkillResult {
  projectId: string;
  skillId: string;
  stage: IssueStatus | null;
}

export async function registerSkillForProject(
  input: RegisterSkillInput,
): Promise<RegisterSkillResult> {
  const { projectId, skillId, stage, actorUserId } = input;

  if (stage === null) {
    await db
      .delete(skillRegistrations)
      .where(
        and(eq(skillRegistrations.projectId, projectId), eq(skillRegistrations.skillId, skillId)),
      );
    return { projectId, skillId, stage: null };
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(skillRegistrations)
      .values({ projectId, skillId, stage, registeredBy: actorUserId })
      .onConflictDoUpdate({
        target: [skillRegistrations.projectId, skillRegistrations.stage],
        set: { skillId: sql`excluded.skill_id`, registeredBy: sql`excluded.registered_by` },
      });
    await tx
      .delete(skillRegistrations)
      .where(
        and(
          eq(skillRegistrations.projectId, projectId),
          eq(skillRegistrations.skillId, skillId),
          ne(skillRegistrations.stage, stage),
        ),
      );
  });

  return { projectId, skillId, stage };
}
