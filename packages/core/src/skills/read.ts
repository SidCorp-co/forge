import { and, asc, eq, or, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { skills } from '../db/schema.js';

type SkillFullRow = typeof skills.$inferSelect;

/** Which skills a list answers: the globals, one project's own, or the globals plus one project's. */
type SkillListScope =
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

export async function studioSkillsOf(
  projectId: string,
): Promise<{ globals: SkillFullRow[]; projectSkills: SkillFullRow[] }> {
  const globals = await listSkills({ kind: 'global' });
  const projectSkills = await listSkills({ kind: 'project', projectId });
  return { globals, projectSkills };
}
