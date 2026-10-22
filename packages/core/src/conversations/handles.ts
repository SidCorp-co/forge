import { and, asc, eq, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { HTTPException } from 'hono/http-exception';
import { agentAccountRow, isAgentHandle } from '../auth/agent-account.js';
import { organizationMembers, projectMembers, projects, users } from '../db/schema.js';
import type { Executor } from './db-executor.js';

const LOCK_NAMESPACE = 'forge:conversation-handle';

export interface ProjectHandle {
  userId: string;
  handle: string;
  /** True only when THIS call created it — what the reverse migration deletes on. */
  minted: boolean;
}

export function handleNameForProject(slug: string, projectId: string): string {
  const derived = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return isAgentHandle(derived) ? derived : `agent-${projectId.slice(0, 8)}`;
}

/**
 * The handle this project ALREADY has, or null — the look without the mint.
 */
export async function existingProjectHandle(
  tx: Executor,
  projectId: string,
): Promise<{ userId: string; handle: string | null } | undefined> {
  const other = alias(projectMembers, 'other_membership');
  const [row] = await tx
    .select({ userId: users.id, handle: organizationMembers.handle })
    .from(users)
    .innerJoin(projectMembers, eq(projectMembers.userId, users.id))
    .leftJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(users.kind, 'agent'),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(other)
            .where(and(eq(other.userId, users.id), ne(other.projectId, projectId))),
        ),
      ),
    )
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  return row;
}

/**
 * The agent of this organization already answering to `handle`, and whether it still holds a role on
 * any project: one that holds none is a project's own agent that lost its role there (ISS-1229 r35).
 */
export async function agentHoldingHandle(
  tx: Executor,
  orgId: string,
  handle: string,
): Promise<{ userId: string; holdsARole: boolean } | undefined> {
  const [row] = await tx
    .select({ userId: users.id })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.handle, handle),
        eq(users.kind, 'agent'),
      ),
    )
    .limit(1);
  if (!row) return undefined;
  const [role] = await tx
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, row.userId))
    .limit(1);
  return { userId: row.userId, holdsARole: Boolean(role) };
}

/**
 * The project's handle, reused where it has one and minted where it does not.
 *
 * Must run inside a transaction: the advisory lock it takes is transaction
 * scoped, and it is the only thing standing between two first-time venues of
 * one handle-less project and two handles for that project.
 *
 * `mintAs` is the id a minted account takes, for a caller that named its actor
 * before the mint; where one already exists, that one is returned whatever id was asked.
 */
export async function resolveProjectHandle(
  tx: Executor,
  projectId: string,
  mintAs?: string,
): Promise<ProjectHandle> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${LOCK_NAMESPACE}), hashtext(${projectId}))`,
  );

  const existing = await existingProjectHandle(tx, projectId);
  if (existing?.handle) {
    return { userId: existing.userId, handle: existing.handle, minted: false };
  }
  if (existing) {
    throw new HTTPException(500, {
      message:
        "This project's agent carries no handle on its organization membership, so it has no address to be reached at",
      cause: { code: 'HANDLE_HAS_NO_NAME', details: { projectId, handleUserId: existing.userId } },
    });
  }

  const [project] = await tx
    .select({ id: projects.id, slug: projects.slug, name: projects.name, orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    throw new HTTPException(404, {
      message: 'There is no such project, so it has no agent to address',
      cause: { code: 'NOT_FOUND', details: { projectId } },
    });
  }

  const handle = handleNameForProject(project.slug, project.id);
  // A second agent would collide on the address the first still holds, a server error after the
  // caller's write (judge-95); the reason is said instead.
  const holder = await agentHoldingHandle(tx, project.orgId, handle);
  if (holder) {
    throw new HTTPException(409, {
      message: holder.holdsARole
        ? `This project's agent would answer to @${handle}, which another agent of the organization already answers to, so it has no address of its own`
        : `@${handle}, the agent of ${project.name}, no longer holds a role on ${project.name}, so it cannot answer there; give it a role on ${project.name} again first`,
      cause: {
        code: holder.holdsARole ? 'HANDLE_TAKEN' : 'PROJECT_AGENT_LOST_ROLE',
        details: { projectId, handleUserId: holder.userId },
      },
    });
  }
  const [created] = await tx
    .insert(users)
    .values(agentAccountRow(handle, mintAs))
    .returning({ id: users.id });
  if (!created) throw new Error('conversations: agent-account insert returned no row');

  await tx
    .insert(organizationMembers)
    .values({ orgId: project.orgId, userId: created.id, role: 'member', handle });
  await tx
    .insert(projectMembers)
    .values({ projectId: project.id, userId: created.id, role: 'member' })
    .onConflictDoNothing();

  return { userId: created.id, handle, minted: true };
}
