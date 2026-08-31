/**
 * Project lookups both transports share.
 *
 * Slug→id resolution had two byte-identical copies — one in `mcp/tools/lib.ts`
 * behind `X-Forge-Project-Slug`, one in `chat-logs/routes.ts` — each returning
 * a different shape of "not found". The routes that select extra columns
 * (`webhooks/inbound-routes.ts`, `agent-sessions/lifecycle-routes.ts`) are
 * genuinely different queries and keep their own.
 */

import { randomBytes } from 'node:crypto';
import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, issues, projectMembers, projects } from '../db/schema.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';

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

export type ProjectBranches = { baseBranch: string | null; productionBranch: string | null };

/** The branches a project's pipeline works against, or `null` when it is gone. */
export async function readProjectBranches(projectId: string): Promise<ProjectBranches | null> {
  const [row] = await db
    .select({ baseBranch: projects.baseBranch, productionBranch: projects.productionBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

/** A project slug already in use. Each transport maps this to its own status. */
export class ProjectSlugTakenError extends Error {
  constructor() {
    super('slug already in use');
    this.name = 'ProjectSlugTakenError';
  }
}

export type NewProject = {
  slug: string;
  name: string;
  orgId: string;
  createdBy: string;
  description?: string | null | undefined;
  kind?: (typeof projects.$inferInsert)['kind'] | undefined;
  repoPath?: string | undefined;
  baseBranch?: string | undefined;
  productionBranch?: string | undefined;
};

/** A freshly generated project API key: `fk_` + 192 bits, the shape every validator accepts. */
export function generateApiKey(): string {
  return `fk_${randomBytes(24).toString('hex')}`;
}

// cm:guard the project row and the creator's `admin` membership land in ONE transaction. A project whose creator is not a member is invisible to its own owner — `loadVisibleProjectIds` reads membership — so a failure between the two would strand a slug nobody can reach or reclaim.
// cm:guard ISS-274 — `baseBranch`/`productionBranch` default to 'main' HERE, at create. `resolveIssueBranches` deliberately has no 'main' fallback (branches/resolve.ts), so a null column does not surface until pipeline time, on an issue, as a failure nobody connects to project creation.
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
          apiKey: generateApiKey(),
          baseBranch: input.baseBranch ?? 'main',
          productionBranch: input.productionBranch ?? 'main',
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.repoPath !== undefined ? { repoPath: input.repoPath } : {}),
        })
        .returning({
          id: projects.id,
          slug: projects.slug,
          name: projects.name,
          orgId: projects.orgId,
          createdBy: projects.createdBy,
          apiKey: projects.apiKey,
          createdAt: projects.createdAt,
        });
      if (!project) throw new Error('projects: insert returned no row');

      await tx.insert(projectMembers).values({
        userId: input.createdBy,
        projectId: project.id,
        role: 'admin',
      });
      return project;
    });
  } catch (err) {
    // cm:guard disambiguate by CONSTRAINT NAME, never by "it was a 23505". Three unique indexes can raise here — the slug, the api key, and any future one on `projects` — and reporting an apiKey collision as SLUG_TAKEN sends the caller to rename a slug that was never the problem. The REST path did exactly that until both transports came through here.
    if (isUniqueViolation(err) && uniqueViolationConstraint(err) === 'projects_slug_unique') {
      throw new ProjectSlugTakenError();
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

/** The projects in `ids`, name and org only. Visibility is the caller's to decide. */
export async function listProjectsByIds(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select(projectListColumns).from(projects).where(inArray(projects.id, ids));
}

/** The scalar view of one project, without its config blobs. */
export async function readProjectSummary(projectId: string) {
  const [row] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      description: projects.description,
      orgId: projects.orgId,
      createdBy: projects.createdBy,
      repoPath: projects.repoPath,
      workspaceSetup: projects.workspaceSetup,
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
      defaultDeviceId: projects.defaultDeviceId,
      previewDeploy: projects.previewDeploy,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

export async function readPreviewDeploy(projectId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ previewDeploy: projects.previewDeploy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return (row?.previewDeploy ?? {}) as Record<string, unknown>;
}

export async function updateProject(projectId: string, updates: Record<string, unknown>) {
  const [row] = await db.update(projects).set(updates).where(eq(projects.id, projectId)).returning({
    id: projects.id,
    slug: projects.slug,
    name: projects.name,
    orgId: projects.orgId,
    description: projects.description,
    repoPath: projects.repoPath,
    workspaceSetup: projects.workspaceSetup,
    baseBranch: projects.baseBranch,
    productionBranch: projects.productionBranch,
    kind: projects.kind,
  });
  return row ?? null;
}

/** How many agent sessions are still live on this project. */
export async function countActiveSessions(projectId: string): Promise<number> {
  const [row] = await db
    .select({ active: count() })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        inArray(agentSessions.status, ['queued', 'running']),
      ),
    );
  return Number(row?.active ?? 0);
}

/** Delete the project row; `false` when there was nothing to delete. */
export async function deleteProject(projectId: string): Promise<boolean> {
  const deleted = await db
    .delete(projects)
    .where(eq(projects.id, projectId))
    .returning({ id: projects.id });
  return deleted.length > 0;
}

/** The project's identity and branches plus its whole agentConfig blob. */
export async function readProjectWithConfig(projectId: string) {
  const [row] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      repoPath: projects.repoPath,
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
      agentConfig: projects.agentConfig,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

/** One issue's session context, scoped to a project so an id from elsewhere reads as absent. */
export async function readIssueSessionContext(issueId: string, projectId: string) {
  const [row] = await db
    .select({ id: issues.id, sessionContext: issues.sessionContext })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)))
    .limit(1);
  return row ?? null;
}
