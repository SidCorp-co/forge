import { and, asc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, skillRegistrations, skills } from '../db/schema.js';

export type SkillFullRow = typeof skills.$inferSelect;

/** Which skills a list answers: the globals, one project's own, or the globals plus one project's. */
export type SkillListScope =
  | { kind: 'global' }
  | { kind: 'project'; projectId: string }
  | { kind: 'global-and-project'; projectId: string };

/** The skills in `scope`, by name. */
export async function listSkills(scope: SkillListScope): Promise<SkillFullRow[]> {
  const where: SQL =
    scope.kind === 'global'
      ? eq(skills.scope, 'global')
      : scope.kind === 'project'
        ? (and(eq(skills.scope, 'project'), eq(skills.projectId, scope.projectId)) as SQL)
        : (or(
            eq(skills.scope, 'global'),
            and(eq(skills.scope, 'project'), eq(skills.projectId, scope.projectId)) as SQL,
          ) as SQL);
  return db.select().from(skills).where(where).orderBy(asc(skills.name));
}

/** One skill by id, or null. */
export async function skillById(id: string): Promise<SkillFullRow | null> {
  const [row] = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
  return row ?? null;
}

/** A skill's owning project and scope, or null. */
export async function skillScopeById(
  id: string,
): Promise<{ id: string; projectId: string | null; scope: SkillFullRow['scope'] } | null> {
  const [row] = await db
    .select({ id: skills.id, projectId: skills.projectId, scope: skills.scope })
    .from(skills)
    .where(eq(skills.id, id))
    .limit(1);
  return row ?? null;
}

/** Each skill a project sees (its own and the globals) with the stages it is registered on. */
export async function skillSyncStatusOf(projectId: string) {
  const projectSkills = await db
    .select({
      id: skills.id,
      name: skills.name,
      target: skills.target,
      scope: skills.scope,
      contentHash: skills.contentHash,
      version: skills.version,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(or(eq(skills.scope, 'global'), eq(skills.projectId, projectId)) as SQL);

  if (projectSkills.length === 0) return [];

  const registrations = await db
    .select({ skillId: skillRegistrations.skillId, stage: skillRegistrations.stage })
    .from(skillRegistrations)
    .where(
      and(
        eq(skillRegistrations.projectId, projectId),
        inArray(
          skillRegistrations.skillId,
          projectSkills.map((s) => s.id),
        ),
      ),
    );

  const stagesBySkill = new Map<string, string[]>();
  for (const reg of registrations) {
    const arr = stagesBySkill.get(reg.skillId) ?? [];
    arr.push(reg.stage);
    stagesBySkill.set(reg.skillId, arr);
  }

  return projectSkills.map((s) => ({
    skillId: s.id,
    skillName: s.name,
    target: s.target,
    scope: s.scope,
    currentHash: s.contentHash,
    currentVersion: s.version,
    updatedAt: s.updatedAt,
    registeredStages: stagesBySkill.get(s.id) ?? [],
  }));
}

/** A project's per-stage skill bindings. */
export async function listSkillRegistrations(projectId: string) {
  return db
    .select({
      stage: skillRegistrations.stage,
      skillId: skillRegistrations.skillId,
      skillName: skills.name,
      skillScope: skills.scope,
      registeredBy: skillRegistrations.registeredBy,
      createdAt: skillRegistrations.createdAt,
    })
    .from(skillRegistrations)
    .innerJoin(skills, eq(skills.id, skillRegistrations.skillId))
    .where(eq(skillRegistrations.projectId, projectId));
}

/** The skill registered on one stage of a project, or null. */
export async function registeredSkillIdAt(
  projectId: string,
  stage: IssueStatus,
): Promise<string | null> {
  const [row] = await db
    .select({ skillId: skillRegistrations.skillId })
    .from(skillRegistrations)
    .where(and(eq(skillRegistrations.projectId, projectId), eq(skillRegistrations.stage, stage)))
    .limit(1);
  return row?.skillId ?? null;
}

/** The global skills and a project's own skills, each by name, not deduplicated. */
export async function studioSkillsOf(
  projectId: string,
): Promise<{ globals: SkillFullRow[]; projectSkills: SkillFullRow[] }> {
  const globals = await listSkills({ kind: 'global' });
  const projectSkills = await listSkills({ kind: 'project', projectId });
  return { globals, projectSkills };
}
