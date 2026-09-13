// A project's handle: the agent a person addresses when they talk to that
// project in a room, and the only thing a conversation's scope comes from.
//
// It is an ISS-932 agent account and nothing new — a `users` row wearing
// `kind:'agent'`, a member of one org and one project, whose authorization is
// the membership it holds. What this module adds is that a conversation may
// mint one, and that it mints one WITHOUT a token.

import { and, asc, eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import {
  handleFromAgentEmail,
  isAgentHandle,
  synthesizeAgentEmail,
} from '../auth/agent-account.js';
import { organizationMembers, projectMembers, projects, users } from '../db/schema.js';
import type { Executor } from './db-executor.js';

const LOCK_NAMESPACE = 'forge:conversation-handle';

export interface ProjectHandle {
  userId: string;
  handle: string;
  /** True only when THIS call created it — what the reverse migration deletes on. */
  minted: boolean;
}

// cm:guard the handle is derived from the slug rather than asked for, because nothing in a room chooses it and a project that cannot produce a legal handle must still be addressable; `isAgentHandle`'s shape is the authority and the id-based fallback is what a slug of punctuation resolves to.
export function handleNameForProject(slug: string, projectId: string): string {
  const derived = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return isAgentHandle(derived) ? derived : `agent-${projectId.slice(0, 8)}`;
}

/**
 * The project's handle, reused where it has one and minted where it does not.
 *
 * Must run inside a transaction: the advisory lock it takes is transaction
 * scoped, and it is the only thing standing between two first-time venues of
 * one handle-less project and two handles for that project.
 */
// cm:guard the lock comes BEFORE the look, not around the insert: without it both callers read no account, both mint, and the project ends with two handles whose union is still one project — so nothing downstream ever reports the duplicate. The conversations' unique index cannot serialize this because the two venues' external ids differ (ISS-1001 criterion 43).
// cm:guard a handle is minted with NO `personal_access_tokens` row and that is the point: it is a name in a room, and an agent with no token cannot act. Minting a credential here would put a principal with write authority into every room a person opens.
// cm:edge contract -> packages/core/src/orgs/agent-accounts.ts — `createAgentAccount` is the same account shape reached from the org console, and it DOES mint a token; a column added to the shape there has to arrive here too, and `0239_conversations.sql` holds a third copy in SQL because a migration cannot call either.
export async function resolveProjectHandle(
  tx: Executor,
  projectId: string,
): Promise<ProjectHandle> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${LOCK_NAMESPACE}), hashtext(${projectId}))`,
  );

  const [existing] = await tx
    .select({ userId: users.id, email: users.email })
    .from(users)
    .innerJoin(projectMembers, eq(projectMembers.userId, users.id))
    .where(and(eq(projectMembers.projectId, projectId), eq(users.kind, 'agent')))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  if (existing) {
    return { userId: existing.userId, handle: handleFromAgentEmail(existing.email), minted: false };
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
      // cm:guard stamped verified at creation for the same reason `createAgentAccount` does it: `assertEmailVerified` gates the PAT-authenticated REST surface and an agent has no mailbox. It is safe only because `signUserToken` refuses `kind:'agent'` outright.
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!created) throw new Error('conversations: agent-account insert returned no row');

  await tx
    .insert(organizationMembers)
    .values({ orgId: project.orgId, userId: created.id, role: 'member' })
    .onConflictDoNothing();
  await tx
    .insert(projectMembers)
    .values({ projectId: project.id, userId: created.id, role: 'member' })
    .onConflictDoNothing();

  return { userId: created.id, handle, minted: true };
}
