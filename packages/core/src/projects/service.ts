/**
 * Project lookups both transports share.
 *
 * Slug→id resolution is shared by `projects/project-scope.ts` (behind
 * `X-Forge-Project-Slug`). The routes that select extra columns
 * (`webhooks/inbound-routes.ts`, `agent-sessions/lifecycle-routes.ts`) are
 * genuinely different queries and keep their own.
 */

import type { ProjectPermission } from '@forge/contracts/permissions';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import {
  type OrgMemberRole,
  organizationMembers,
  type ProjectMemberRole,
  projectGitCredentials,
  projectInvitations,
  projectMembers,
  projects,
} from '../db/schema.js';
import { visibleProjectsWhere } from '../lib/authz.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';
import {
  addProjectMembers,
  regrantAgentCredentials,
  removeProjectMember,
  updateProjectMember,
} from '../permissions/index.js';
import { seedProjectPolicy } from '../project-config/index.js';
import { type AgentConfigKeyPatch, patchAgentConfigKeys } from './agent-config.js';
import { applyIssuePrefixPatch } from './issue-prefix-patch.js';
import { PATCHED_PROJECT } from './projections.js';
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

type NewProject = {
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
      await seedProjectPolicy(tx, project.id, input.createdBy);
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

const projectListColumns = {
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

/** Add `userId` to the project; null when they were already a member. */
export async function addProjectMemberIfAbsent(
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
) {
  const [inserted] = await addProjectMembers(db, [{ userId, projectId, role }], {
    ifAbsent: true,
  });
  return inserted ?? null;
}

/**
 * Change a member's role or grant; null when the membership is gone. An agent's live credentials
 * take the new grant's token-explicit permissions in the same transaction.
 */
export async function changeProjectMember(
  projectId: string,
  userId: string,
  patch: { role?: ProjectMemberRole | undefined; grants?: ProjectPermission[] | undefined },
) {
  return db.transaction(async (tx) => {
    const row = await updateProjectMember(tx, projectId, userId, patch);
    if (row && patch.grants !== undefined) await regrantAgentCredentials(tx, userId);
    return row;
  });
}

/** Remove a member from the project. */
export async function dropProjectMember(projectId: string, userId: string): Promise<void> {
  await removeProjectMember(db, projectId, userId);
}

/** Revoke the pending invitation for `email`; false when there was none. */
export async function revokeProjectInvitation(projectId: string, email: string): Promise<boolean> {
  const deleted = await db
    .delete(projectInvitations)
    .where(
      and(
        eq(projectInvitations.projectId, projectId),
        eq(projectInvitations.email, email),
        isNull(projectInvitations.acceptedAt),
      ),
    )
    .returning({ token: projectInvitations.token });
  return deleted.length > 0;
}

/** Dismiss the pending invitation `token` when it was sent to `email`; false when none matched. */
export async function declineProjectInvitation(token: string, email: string): Promise<boolean> {
  const [updated] = await db
    .update(projectInvitations)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(projectInvitations.token, token),
        sql`lower(${projectInvitations.email}) = lower(${email})`,
        isNull(projectInvitations.acceptedAt),
      ),
    )
    .returning({ token: projectInvitations.token });
  return updated !== undefined;
}

/**
 * The settings patch in one transaction: agent-config keys, the issue prefix, and a move to
 * another org. Answers the patched project, or null when it is gone.
 */
export async function updateProjectSettings(
  projectId: string,
  userId: string,
  patch: {
    orgId?: string | undefined;
    agentConfig: AgentConfigKeyPatch;
    issuePrefix?: string | null | undefined;
  },
) {
  const [updated] = await db.transaction(async (tx) => {
    await patchAgentConfigKeys(projectId, patch.agentConfig, tx);
    if (patch.issuePrefix !== undefined) {
      await applyIssuePrefixPatch(projectId, patch.issuePrefix, userId, tx);
    }
    if (patch.orgId === undefined) {
      return tx.select(PATCHED_PROJECT).from(projects).where(eq(projects.id, projectId)).limit(1);
    }
    return tx
      .update(projects)
      .set({ orgId: patch.orgId })
      .where(eq(projects.id, projectId))
      .returning(PATCHED_PROJECT);
  });
  return updated ?? null;
}

/** Hard-delete the project row. */
export async function deleteProject(projectId: string): Promise<void> {
  await withKernelMarker(db, async (tx) => tx.delete(projects).where(eq(projects.id, projectId)));
}

const ARCHIVE_PROJECTION = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  orgId: projects.orgId,
  createdBy: projects.createdBy,
  archivedAt: projects.archivedAt,
  createdAt: projects.createdAt,
} as const;

/** Archive the project (idempotent: an earlier `archived_at` stands); null when it is gone. */
export async function archiveProject(projectId: string) {
  const [updated] = await db
    .update(projects)
    .set({ archivedAt: sql`coalesce(${projects.archivedAt}, now())` })
    .where(eq(projects.id, projectId))
    .returning(ARCHIVE_PROJECTION);
  return updated ?? null;
}

/** Clear the project's archive; null when it is gone. */
export async function unarchiveProject(projectId: string) {
  const [updated] = await db
    .update(projects)
    .set({ archivedAt: null })
    .where(eq(projects.id, projectId))
    .returning(ARCHIVE_PROJECTION);
  return updated ?? null;
}

/** The project's git access uses pool key `sshKeyId`, replacing any earlier pick. */
export async function pickProjectGitKey(
  projectId: string,
  sshKeyId: string,
  userId: string,
): Promise<void> {
  await db
    .insert(projectGitCredentials)
    .values({ projectId, sshKeyId, createdBy: userId })
    .onConflictDoUpdate({
      target: projectGitCredentials.projectId,
      set: { sshKeyId, createdBy: userId, updatedAt: new Date() },
    });
}

/** Forget the project's picked git key. */
export async function clearProjectGitKey(projectId: string): Promise<void> {
  await db.delete(projectGitCredentials).where(eq(projectGitCredentials.projectId, projectId));
}
