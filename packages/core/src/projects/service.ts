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
} from '../db/schema.js';
import { projectPolicies } from '../db/schema-project-config.js';
import { visibleProjectsWhere } from '../lib/authz.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';
import { DEFAULT_POLICY } from '../project-config/default-policy.js';
import type { ReleaseChain } from './release-chain.js';

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
  releaseChain: ReleaseChain;
};

/** The branches a project's pipeline works against, or `null` when it is gone. */
export async function readProjectBranches(projectId: string): Promise<ProjectBranches | null> {
  const [row] = await db
    .select({
      baseBranch: projects.baseBranch,
      releaseChain: projects.releaseChain,
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
  repoPath?: string | undefined;
  baseBranch?: string | undefined;
  releaseChain?: ReleaseChain | undefined;
};

/** A freshly generated project API key: `fk_` + 192 bits, the shape every validator accepts. */
export function generateApiKey(): string {
  return `fk_${randomBytes(24).toString('hex')}`;
}

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
          ...(input.releaseChain !== undefined ? { releaseChain: input.releaseChain } : {}),
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
      await tx.insert(projectPolicies).values({
        projectId: project.id,
        revision: 1,
        document: DEFAULT_POLICY,
        updatedBy: input.createdBy,
      });
      return project;
    });
  } catch (err) {
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
      orgId: projects.orgId,
      createdBy: projects.createdBy,
      repoPath: projects.repoPath,
      workspaceSetup: projects.workspaceSetup,
      baseBranch: projects.baseBranch,
      releaseChain: projects.releaseChain,
      defaultDeviceId: projects.defaultDeviceId,
      environments: projects.environments,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

export async function updateProject(projectId: string, updates: Record<string, unknown>) {
  const [row] = await db.update(projects).set(updates).where(eq(projects.id, projectId)).returning({
    id: projects.id,
    slug: projects.slug,
    name: projects.name,
    orgId: projects.orgId,
    repoPath: projects.repoPath,
    workspaceSetup: projects.workspaceSetup,
    baseBranch: projects.baseBranch,
    releaseChain: projects.releaseChain,
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
      releaseChain: projects.releaseChain,
      agentConfig: projects.agentConfig,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
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
