/**
 * Project lookups both transports share.
 *
 * Slug→id resolution had two byte-identical copies — one in `mcp/tools/lib.ts`
 * behind `X-Forge-Project-Slug`, one in `chat-logs/routes.ts` — each returning
 * a different shape of "not found". The routes that select extra columns
 * (`webhooks/inbound-routes.ts`, `agent-sessions/lifecycle-routes.ts`) are
 * genuinely different queries and keep their own.
 */

import type { ProjectPermission } from '@forge/contracts/permissions';
import { RUNNER_MACHINE, RUNNER_PROVISION_MACHINE } from '@forge/contracts/runner-machine';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import {
  issues,
  type OrgMemberRole,
  organizationMembers,
  projectGitCredentials,
  projectInvitations,
  type ProjectMemberRole,
  projectMembers,
  projects,
  runners,
} from '../db/schema.js';
import { visibleProjectsWhere } from '../lib/authz.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';
import { type KernelActor, transition } from '../lifecycle/transition.js';
import {
  addProjectMembers,
  removeProjectMember,
  updateProjectMember,
} from '../permissions/index.js';
import { DEFAULT_POLICY } from '../project-config/default-policy.js';
import { seedProjectPolicy } from '../project-config/store.js';
import { readDeclaredSource } from '../project-config/source.js';
import { upsertDeviceRunner } from '../runners/index.js';
import { insertRunnerEvent } from '../runners/runner-events.js';
import { defaultRunnerCapabilities } from '../runners/select.js';
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

/** Change a member's role or grant; null when the membership is gone. */
export async function changeProjectMember(
  projectId: string,
  userId: string,
  patch: { role?: ProjectMemberRole | undefined; grants?: ProjectPermission[] | undefined },
) {
  return updateProjectMember(db, projectId, userId, patch);
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

/**
 * Bind a device to the project as its claude-code runner: upsert the row, re-queue provisioning,
 * take the device's liveness, then audit the bind as the runner's first status event. Null when
 * the upsert returned no row.
 */
export async function bindDeviceRunner(input: {
  projectId: string;
  device: { id: string; name: string; status: string; lastSeenAt: Date | null };
  capabilities: Record<string, unknown> | undefined;
  checkout: { repoPath?: string | null | undefined; branch?: string | null | undefined };
  actor: KernelActor;
}) {
  const status: 'online' | 'offline' =
    input.device.status === 'online' && input.device.lastSeenAt ? 'online' : 'offline';
  const now = new Date();
  const runner = await db.transaction(async (tx) => {
    const row = await upsertDeviceRunner(tx, {
      projectId: input.projectId,
      deviceId: input.device.id,
      name: input.device.name,
      capabilities: defaultRunnerCapabilities('claude-code', input.capabilities),
      capabilitiesSent: input.capabilities,
      checkout: input.checkout,
      status,
      now,
    });
    if (!row) return null;
    // A re-bind re-queues provisioning (path or url may have changed); an operator's drain or
    // disable is left standing.
    await transition(tx, RUNNER_PROVISION_MACHINE, {
      to: 'queued',
      where: eq(runners.id, row.id),
      reason: 'bind',
      actor: input.actor,
      source: 'runner-bind',
      returning: ['id'],
    });
    const live = await transition(tx, RUNNER_MACHINE, {
      to: status,
      from: status === 'online' ? 'offline' : 'online',
      where: eq(runners.id, row.id),
      reason: 'bind',
      actor: input.actor,
      source: 'runner-bind',
      returning: ['id'],
    });
    return live.rows.length > 0 ? { ...row, status } : row;
  });
  if (!runner) return null;

  // ISS-381 (2.3) — an event per bind is informative, unlike the per-tick heartbeat site.
  await insertRunnerEvent(db, {
    runnerId: runner.id,
    projectId: runner.projectId,
    oldStatus: null,
    newStatus: runner.status,
    reason: 'bind',
  });
  return runner;
}
