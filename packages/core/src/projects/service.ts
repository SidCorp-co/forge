/**
 * Project lookups both transports share.
 *
 * Slug→id resolution is shared by `projects/project-scope.ts` (behind
 * `X-Forge-Project-Slug`) and `chat-logs/routes.ts`. The routes that select extra columns
 * (`webhooks/inbound-routes.ts`, `agent-sessions/lifecycle-routes.ts`) are
 * genuinely different queries and keep their own.
 */

import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  issues,
  type OrgMemberRole,
  organizationMembers,
  type ProjectMemberRole,
  projectMembers,
  projects,
} from '../db/schema.js';
import { visibleProjectsWhere } from '../lib/authz.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';
import { addProjectMembers } from '../permissions/index.js';
import { DEFAULT_POLICY } from '../project-config/default-policy.js';
import { readDeclaredSource } from '../project-config/source.js';
import { seedProjectPolicy } from '../project-config/store.js';
import { refuse } from './refuse.js';

/** The project's id, or `null` when no project carries that slug. */
export async function findProjectIdBySlug(slug: string): Promise<string | null> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

/** The org a project belongs to, or `null` when the project is gone. */
export async function findProjectOrgId(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.orgId ?? null;
}

export type ProjectBranches = {
  /** Where an ISS-* branch is cut from. NOT a release fact. */
  baseBranch: string | null;
};

/** The branch a project's pipeline cuts work from, or `null` when the project is gone. */
export async function readProjectBranches(projectId: string): Promise<ProjectBranches | null> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  return { baseBranch: (await readDeclaredSource(projectId)).defaultBranch };
}

export type NewProject = {
  slug: string;
  name: string;
  orgId: string;
  createdBy: string;
};

export async function createProject(input: NewProject) {
  try {
    return await db.transaction(async (tx) => {
      const [project] = await tx
        .insert(projects)
        .values({
          slug: input.slug,
          name: input.name,
          orgId: input.orgId,
          createdBy: input.createdBy,
        })
        .returning({
          id: projects.id,
          slug: projects.slug,
          name: projects.name,
          orgId: projects.orgId,
          createdBy: projects.createdBy,
          createdAt: projects.createdAt,
        });
      if (!project) throw new Error('projects: insert returned no row');

      await addProjectMembers(tx, [
        { userId: input.createdBy, projectId: project.id, role: 'admin' },
      ]);
      await seedProjectPolicy(tx, project.id, DEFAULT_POLICY, input.createdBy);
      return project;
    });
  } catch (err) {
    if (isUniqueViolation(err) && uniqueViolationConstraint(err) === 'projects_slug_unique') {
      throw refuse(
        'SLUG_TAKEN',
        `the slug \`${input.slug}\` is already in use; pick another`,
        '/slug',
      );
    }
    throw err;
  }
}

export const projectListColumns = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
} as const;

/** One visible project, with the two membership rows the visibility join already reads. */
export type VisibleProjectWithRole = {
  id: string;
  slug: string;
  name: string;
  orgId: string;
  memberRole: ProjectMemberRole | null;
  orgRole: OrgMemberRole | null;
  /** The membership's grant beyond its role; empty where the caller is not a member. */
  grants: string[] | null;
};

export async function listVisibleProjectsWithRole(
  userId: string | null | undefined,
): Promise<VisibleProjectWithRole[]> {
  if (!userId) return [];
  return db
    .select({
      ...projectListColumns,
      memberRole: projectMembers.role,
      orgRole: organizationMembers.role,
      grants: projectMembers.grants,
    })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.userId, userId)),
    )
    .where(and(...visibleProjectsWhere()));
}

/** The two jsonb fields a per-issue branch override can live on, scoped to a project so an id from elsewhere reads as absent. */
export async function readIssueBranchInputs(issueId: string, projectId: string) {
  const [row] = await db
    .select({ id: issues.id, metadata: issues.metadata, sessionContext: issues.sessionContext })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

/** The project's issue prefix; null sends it back to the legacy `ISS`. */
export async function setProjectIssuePrefix(
  projectId: string,
  prefix: string | null,
  tx: Pick<Tx, 'update'> = db,
): Promise<void> {
  await tx.update(projects).set({ issuePrefix: prefix }).where(eq(projects.id, projectId));
}

/** The slug and name the project document declares, projected onto the row; false when no row. */
export async function projectDocumentNames(
  tx: Tx,
  projectId: string,
  names: { slug: string; name: string },
): Promise<boolean> {
  const projected = await tx
    .update(projects)
    .set({ slug: names.slug, name: names.name })
    .where(eq(projects.id, projectId))
    .returning({ id: projects.id });
  return projected.length > 0;
}
