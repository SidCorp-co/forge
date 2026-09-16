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
import {
  agentSessions,
  issues,
  type OrgMemberRole,
  organizationMembers,
  type ProjectMemberRole,
  projectMembers,
  projects,
  type ReleaseModel,
  type ReleaseStrategy,
} from '../db/schema.js';
import { visibleProjectsWhere } from '../lib/authz.js';
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

export type ProjectBranches = {
  baseBranch: string | null;
  liveBranch: string | null;
  releaseModel: ReleaseModel;
  releaseStrategy: ReleaseStrategy | null;
};

/** The branches a project's pipeline works against, or `null` when it is gone. */
export async function readProjectBranches(projectId: string): Promise<ProjectBranches | null> {
  const [row] = await db
    .select({
      baseBranch: projects.baseBranch,
      liveBranch: projects.liveBranch,
      releaseModel: projects.releaseModel,
      releaseStrategy: projects.releaseStrategy,
    })
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
  liveBranch?: string | undefined;
  releaseModel?: ReleaseModel | undefined;
  releaseStrategy?: ReleaseStrategy | undefined;
};

/** A freshly generated project API key: `fk_` + 192 bits, the shape every validator accepts. */
export function generateApiKey(): string {
  return `fk_${randomBytes(24).toString('hex')}`;
}

// cm:guard the project row and the creator's `admin` membership land in ONE transaction. A project whose creator is not a member is invisible to its own owner — `loadVisibleProjectIds` reads membership — so a failure between the two would strand a slug nobody can reach or reclaim.
// cm:guard ISS-274 — `baseBranch` defaults to 'main' HERE, at create. `resolveIssueBranches` deliberately has no 'main' fallback (branches/resolve.ts), so a null column does not surface until pipeline time, on an issue, as a failure nobody connects to project creation.
// cm:guard `liveBranch` does NOT get that default, and the asymmetry is the point (ISS-1046). `baseBranch` has a second job outside release — it is the ref every ISS-* branch is cut from, so every project needs one. `liveBranch` is read only under `releaseModel: 'promote'`, and a new project declares `none`: defaulting it to 'main' is how 25 fleet projects came to carry a production branch they never promote to, including projects with no repository at all.
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
          releaseModel: input.releaseModel ?? 'none',
          ...(input.liveBranch !== undefined ? { liveBranch: input.liveBranch } : {}),
          ...(input.releaseStrategy !== undefined
            ? { releaseStrategy: input.releaseStrategy }
            : {}),
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

/** One visible project, with the two membership rows the visibility join already reads. */
export type VisibleProjectWithRole = {
  id: string;
  slug: string;
  name: string;
  orgId: string;
  memberRole: ProjectMemberRole | null;
  orgRole: OrgMemberRole | null;
};

/**
 * Every project the user can see, with the raw role columns beside it — the
 * ONE query behind `forge_projects.list` (ISS-1025). The visibility predicate
 * is `lib/authz.ts`'s own `visibleProjectsWhere()`, and the caller derives the
 * effective role through that module's `maxProjectRole` /
 * `orgDerivedProjectRole`, so this widens the projection without restating the
 * rule. The list tool used to run this join for the ids, a second query for
 * the columns, and then `effectiveProjectRole` once per row — a third visit to
 * these same two tables per project, serialised.
 */
// cm:why no DISTINCT: `project_members` is PRIMARY KEY (user_id, project_id) and `organization_members` is PRIMARY KEY (org_id, user_id), so each left join matches at most one row and the wider projection is already one row per project. `loadVisibleProjectIds` keeps its `selectDistinct` because narrowing to `projects.id` alone is where duplicates would be visible if either key ever widened.
export async function listVisibleProjectsWithRole(
  userId: string | null | undefined,
): Promise<VisibleProjectWithRole[]> {
  if (!userId) return [];
  return db
    .select({
      ...projectListColumns,
      memberRole: projectMembers.role,
      orgRole: organizationMembers.role,
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
      liveBranch: projects.liveBranch,
        releaseModel: projects.releaseModel,
        releaseStrategy: projects.releaseStrategy,
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
    liveBranch: projects.liveBranch,
        releaseModel: projects.releaseModel,
        releaseStrategy: projects.releaseStrategy,
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

/** The project's identity and branches plus its whole agentConfig blob. */
export async function readProjectWithConfig(projectId: string) {
  const [row] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      repoPath: projects.repoPath,
      baseBranch: projects.baseBranch,
      liveBranch: projects.liveBranch,
        releaseModel: projects.releaseModel,
        releaseStrategy: projects.releaseStrategy,
      agentConfig: projects.agentConfig,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

/** The two jsonb fields a per-issue branch override can live on, scoped to a project so an id from elsewhere reads as absent. */
// cm:guard both jsonb fields are selected because `extractIssueBranchOverride` reads `metadata.branchConfig` FIRST and only falls back to `sessionContext` — omit `metadata` and the caller silently resolves the project default for an issue that carries an override (ISS-936, found with the column already shipped and this select still on `sessionContext` alone).
// cm:edge contract -> packages/core/src/branches/resolve.ts — this row IS `extractIssueBranchOverride`'s argument shape; a field added to that precedence has to be selected here
export async function readIssueBranchInputs(issueId: string, projectId: string) {
  const [row] = await db
    .select({ id: issues.id, metadata: issues.metadata, sessionContext: issues.sessionContext })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)))
    .limit(1);
  return row ?? null;
}
