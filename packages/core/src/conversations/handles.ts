// A project's handle: the agent a person addresses when they talk to that
// project in a room, and the only thing a conversation's scope comes from.
//
// It is an ISS-932 agent account and nothing new — a `users` row wearing
// `kind:'agent'`, a member of one org and one project, whose authorization is
// the membership it holds. What this module adds is that a conversation may
// mint one, and that it mints one WITHOUT a token.
//
// Since ISS-1093 an agent MAY be a member of several projects, so "a member of
// one project" stopped being true of agents in general. It is still what a
// project's handle is, and `existingProjectHandle` now says so rather than
// relying on it.

import { randomBytes } from 'node:crypto';
import { and, asc, eq, ne, notExists, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { isAgentHandle, synthesizeAgentEmail } from '../auth/agent-account.js';
import { organizationMembers, projectMembers, projects, users } from '../db/schema.js';
import { alias } from 'drizzle-orm/pg-core';
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
 * The handle this project ALREADY has, or null — the look without the mint.
 */
// cm:guard the one copy of "which of a project's agents is its handle", so the candidate list can leave out the agent a new room will open with and `resolveProjectHandle` can reuse the same one. Two copies of this ordering would drift into two different answers to that question, and the visible cost of the drift is a confirmation that counts a handle the room will not have (ISS-1011).
export async function existingProjectHandle(
  tx: Executor,
  projectId: string,
): Promise<{ userId: string; handle: string | null } | undefined> {
  // cm:guard a candidate must be a member of THIS project and of no other. Before ISS-1093 that
  // was true of every agent by construction, so this narrowing changes the answer for no row that
  // exists today — it excludes exactly the population ISS-1093 created. Without it, an agent an
  // org admin made to cover eight projects becomes the conversational voice of whichever of them
  // has no handle yet, purely by being older; and unlike a minted handle, which carries no
  // `personal_access_tokens` row on purpose, that agent holds a write-capable credential. The
  // guard on `resolveProjectHandle` below says minting a token here would put a principal with
  // write authority into every room a person opens — this is the same hole reached from the other
  // side, by a token-holding agent walking into the candidate list.
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
 * A name for this org that `(org_id, handle)` will accept, starting from the one
 * the slug gives.
 *
 * The base is taken only when some OTHER agent of this org already answers to it:
 * an agent an admin named after the project, or a former handle of this very
 * project that has since been widened to cover a second one and so no longer
 * qualifies as its voice. Either way the project must still get a voice.
 */
// cm:guard chosen by LOOKING rather than by inserting and catching, because this runs inside the
// caller's transaction and a unique violation aborts the whole of it — there would be nothing left
// to retry on. The advisory lock above already serializes two venues of the same project, and the
// account that holds the base name is not one this statement is creating, so the look is sound.
// cm:guard bounded, and a REFUSAL at the end rather than a loop: the caller never types this name,
// so a collision is ours to resolve, but an unbounded search turns a constraint nobody can satisfy
// into a request that never returns (ISS-1093).
async function freeHandleIn(tx: Executor, orgId: string, base: string): Promise<string> {
  const stem = base.slice(0, 30).replace(/-+$/, '');
  const candidates = [base, `${stem}-2`, `${stem}-${randomBytes(4).toString('hex')}`];
  for (const name of candidates) {
    const [taken] = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.handle, name)))
      .limit(1);
    if (!taken) return name;
  }
  throw new HTTPException(409, {
    message: `every name this org would give project ${orgId}'s handle is already answered to by another agent (${candidates.join(', ')}); rename one of them and open the room again`,
    cause: { code: 'HANDLE_NAME_TAKEN' },
  });
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
// cm:edge contract -> packages/core/src/orgs/agent-accounts.ts — `createAgentAccount` is the same account shape reached from the org console, and it DOES mint a token; a column added to the shape there has to arrive here too, and `0241_conversations.sql` holds a third copy in SQL because a migration cannot call either.
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

  const handle = await freeHandleIn(tx, project.orgId, handleNameForProject(project.slug, project.id));
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

  // cm:guard the handle is written in the SAME insert as the membership it is unique within, never patched on afterwards: a membership that exists for one statement without its handle is a row the `(org_id, handle)` index cannot refuse, so two venues racing the same slug would both pass and the advisory lock above would have bought nothing.
  // cm:guard NO `onConflictDoNothing` here, unlike every other insert in this file: `created.id` is a user this statement made, so the only conflict reachable is `(org_id, handle)` — another agent in this org already answering to this name. Swallowed, the transaction commits an agent with a project membership and no org membership, and the room then fails later at `loadHandle` with `HANDLE_HAS_NO_NAME`, which names the wrong thing entirely. Aborting names the constraint at the row that caused it (ISS-1003 criterion 12).
  await tx
    .insert(organizationMembers)
    .values({ orgId: project.orgId, userId: created.id, role: 'member', handle });
  await tx
    .insert(projectMembers)
    .values({ projectId: project.id, userId: created.id, role: 'member' })
    .onConflictDoNothing();

  return { userId: created.id, handle, minted: true };
}
