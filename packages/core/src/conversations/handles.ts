import { and, asc, eq, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { HTTPException } from 'hono/http-exception';
import { isAgentHandle, synthesizeAgentEmail } from '../auth/agent-account.js';
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
 * The project's handle, reused where it has one and minted where it does not.
 *
 * Must run inside a transaction: the advisory lock it takes is transaction
 * scoped, and it is the only thing standing between two first-time venues of
 * one handle-less project and two handles for that project.
 */
export async function resolveProjectHandle(
  tx: Executor,
  projectId: string,
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
      message: `project ${projectId} has agent ${existing.userId} as its handle but that agent carries no handle on its org membership, so it has no address to be reached at`,
      cause: { code: 'HANDLE_HAS_NO_NAME' },
    });
  }

  const [project] = await tx
    .select({ id: projects.id, slug: projects.slug, orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    throw new HTTPException(404, {
      message: `no project ${projectId}, so it has no handle to address`,
      cause: { code: 'NOT_FOUND' },
    });
  }

  const handle = handleNameForProject(project.slug, project.id);
  const [created] = await tx
    .insert(users)
    .values({
      email: synthesizeAgentEmail(handle),
      kind: 'agent',
      passwordHash: null,
      emailVerifiedAt: new Date(),
    })
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
