// Who a room may still take in, and what taking one in does to the room.
//
// `participants.ts` holds the doors — it decides whether a given add is
// allowed. This holds the two questions a surface asks around them: who is
// worth offering, and what the room becomes once somebody walks through
// (ISS-1011).

import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db as defaultDb } from '../db/client.js';
import { organizationMembers, projectMembers, projects, users } from '../db/schema.js';
import {
  type ConversationAdapter,
  conversationParticipants,
  conversations,
} from '../db/schema-conversations.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import type { Executor, TxOnly } from './db-executor.js';
import { existingProjectHandle, handleNameForProject } from './handles.js';
import { conversationTransport } from './ports.js';
import { appendMessagesIn } from './store.js';

const badRequest = (message: string, code: string) =>
  new HTTPException(400, { message, cause: { code } });

export interface NamedProject {
  id: string;
  name: string;
  slug: string;
}

/**
 * Somebody who could be put in a room, by the address that identifies them.
 */
export interface PersonCandidate {
  userId: string;
  email: string;
}

export interface HandleCandidate {
  /**
   * The people already in this room who would lose it if this agent joined, by id.
   */
  losesReaderIds: string[];
  /**
   * The agent account, or null where this project has never needed one.
   */
  userId: string | null;
  /** The address it answers to — the name it already has, or the one it will be given. */
  handle: string;
  project: NamedProject;
}

/** The projects behind a derived scope, named, in the scope's own order. */
export async function projectsNamed(
  ids: readonly string[],
  tx: Executor = defaultDb,
): Promise<NamedProject[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, [...ids]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * The shape a room takes from the handles in it.
 */
export function shapeForHandleCount(liveHandles: number): 'direct' | 'group' {
  return liveHandles > 1 ? 'group' : 'direct';
}

/** What just changed in the room, for the line the room is told. */
export interface MembershipChange {
  kind: 'person' | 'handle';
  /** How the room names them: a handle as `@name`, a person by their address. */
  label: string;
  verb: 'joined' | 'left';
}

/** How many of each kind are live in the room. */
async function liveCounts(
  tx: Executor,
  conversationId: string,
): Promise<{ handles: number; persons: number }> {
  const rows = await tx
    .select({ kind: conversationParticipants.kind })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        isNull(conversationParticipants.removedAt),
      ),
    );
  return {
    handles: rows.filter((r) => r.kind === 'handle').length,
    persons: rows.filter((r) => r.kind === 'person').length,
  };
}

/**
 * The shape a room takes from who is in it.
 */
export function shapeForCounts(counts: {
  handles: number;
  persons: number;
}): 'direct' | 'group' | null {
  if (counts.persons === 0) return null;
  return counts.handles > 1 || counts.persons > 1 ? 'group' : 'direct';
}

/** Whether this adapter's rooms may change shape; an adapter nobody registered holds its shape. */
function shapeFollows(adapter: ConversationAdapter): boolean {
  return conversationTransport(adapter)?.shapeFollowsMembership === true;
}

/**
 * Move a room's shape to match who is now in it.
 */
export async function settleShape(
  tx: Executor,
  conversationId: string,
  change?: MembershipChange,
): Promise<'direct' | 'group' | null> {
  const [room] = await tx
    .select({ adapter: conversations.adapter, shape: conversations.shape })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!room) return null;
  const counts = await liveCounts(tx, conversationId);
  const movable = shapeFollows(room.adapter);
  const target = movable ? shapeForCounts(counts) : shapeForHandleCount(counts.handles);
  if (target === null || target === room.shape) return null;
  if (!movable && target !== 'group') return null;
  await tx
    .update(conversations)
    .set({ shape: target })
    .where(and(eq(conversations.id, conversationId), eq(conversations.shape, room.shape)));
  if (change) {
    const who = change.kind === 'handle' ? `@${change.label}` : change.label;
    const now = target === 'group' ? 'a group' : 'a one-to-one chat';
    await appendMessagesIn(tx as unknown as TxOnly, {
      conversationId,
      messages: [
        {
          role: 'system',
          content: `${who} ${change.verb}; this room is now ${now}.`,
          authorLabel: 'system',
        },
      ],
    });
  }
  return target;
}

/** How a room names a person: their address, never their display name. */
export async function personLabel(tx: Executor, userId: string): Promise<string> {
  const [row] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? userId;
}

/**
 * Everyone already in this room, live, by user id.
 */
async function liveUserIds(conversationId: string | null, tx: Executor): Promise<Set<string>> {
  if (!conversationId) return new Set();
  const rows = await tx
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        isNull(conversationParticipants.removedAt),
      ),
    );
  return new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])));
}

/**
 * A person may be added only where they could have read the room already.
 */
export async function assertPersonReachesScope(
  userId: string,
  scope: readonly string[],
  tx: Executor = defaultDb,
): Promise<void> {
  for (const projectId of scope) {
    const access = await effectiveProjectRole(userId, projectId);
    if (access?.role) continue;
    const [named] = await projectsNamed([projectId], tx);
    throw badRequest(
      `that person holds no role on ${named ? `project ${named.name}` : `project ${projectId}`}, and a room is read only by somebody holding one on every project in it — give them a role there first`,
      'PERSON_OUT_OF_SCOPE',
    );
  }
}

/**
 * The people this room could still take in.
 */
export async function addablePeople(
  conversationId: string | null,
  scope: readonly string[],
  tx: Executor = defaultDb,
): Promise<PersonCandidate[]> {
  if (scope.length === 0) return [];
  const already = await liveUserIds(conversationId, tx);
  if (conversationId === null) {
    for (const projectId of scope) {
      const opening = await existingProjectHandle(tx, projectId);
      if (opening) already.add(opening.userId);
    }
  }
  const orgIds = await orgsOfProjects(scope, tx);
  if (orgIds.length === 0) return [];

  const pool = await tx
    .selectDistinct({
      userId: users.id,
      email: users.email,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(inArray(organizationMembers.orgId, orgIds), ne(users.kind, 'agent')));

  const out: PersonCandidate[] = [];
  for (const person of pool) {
    if (already.has(person.userId)) continue;
    let reaches = true;
    for (const projectId of scope) {
      if (!(await effectiveProjectRole(person.userId, projectId))?.role) reaches = false;
    }
    if (reaches) out.push(person);
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * The agents this caller could still put in this room.
 */
export async function addableHandles(
  conversationId: string | null,
  actorUserId: string,
  scope: readonly string[],
  tx: Executor = defaultDb,
): Promise<HandleCandidate[]> {
  const already = await liveUserIds(conversationId, tx);
  if (conversationId === null) {
    for (const projectId of scope) {
      const opening = await existingProjectHandle(tx, projectId);
      if (opening) already.add(opening.userId);
    }
  }
  const orgIds = await orgsOfProjects(scope, tx);
  if (orgIds.length === 0) return [];

  const livePeople = conversationId ? await livePersonIds(conversationId, tx) : [];
  const candidateProjects = await tx
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.orgId, orgIds));

  const agents = await tx
    .selectDistinct({
      userId: users.id,
      handle: organizationMembers.handle,
      projectId: projectMembers.projectId,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .where(
      and(
        inArray(
          projectMembers.projectId,
          candidateProjects.map((p) => p.id),
        ),
        eq(users.kind, 'agent'),
      ),
    );

  const out: HandleCandidate[] = [];
  for (const project of candidateProjects) {
    const access = await effectiveProjectRole(actorUserId, project.id);
    if (!projectRoleAtLeast(access?.role ?? null, 'member')) continue;

    const losesReaderIds = scope.includes(project.id)
      ? []
      : await peopleWithoutRoleOn(livePeople, project.id);

    const mine = agents.filter((a) => a.projectId === project.id && a.handle);
    if (mine.length === 0) {
      if (!scope.includes(project.id)) {
        out.push({
          userId: null,
          handle: handleNameForProject(project.slug, project.id),
          project,
          losesReaderIds,
        });
      }
      continue;
    }
    for (const agent of mine) {
      if (already.has(agent.userId)) continue;
      out.push({
        userId: agent.userId,
        handle: agent.handle as string,
        project,
        losesReaderIds,
      });
    }
  }
  return out.sort((a, b) => a.handle.localeCompare(b.handle));
}

/** The live people of a room, by user id. */
async function livePersonIds(conversationId: string, tx: Executor): Promise<string[]> {
  const rows = await tx
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.kind, 'person'),
        isNull(conversationParticipants.removedAt),
      ),
    );
  return rows.flatMap((r) => (r.userId ? [r.userId] : []));
}

async function peopleWithoutRoleOn(userIds: readonly string[], projectId: string) {
  const out: string[] = [];
  for (const userId of userIds) {
    const access = await effectiveProjectRole(userId, projectId);
    if (!projectRoleAtLeast(access?.role ?? null, 'viewer')) out.push(userId);
  }
  return out;
}

async function orgsOfProjects(ids: readonly string[], tx: Executor): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .selectDistinct({ orgId: projects.orgId })
    .from(projects)
    .where(inArray(projects.id, [...ids]));
  return rows.map((r) => r.orgId);
}
