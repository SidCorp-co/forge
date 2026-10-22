// Who a room may still take in, and what taking one in does to the room.
//
// `participants.ts` holds the doors — it decides whether a given add is
// allowed. This holds the two questions a surface asks around them: who is
// worth offering, and what the room becomes once somebody walks through
// (ISS-1011).

import { and, eq, inArray, isNull, min, ne } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { organizationMembers, projectMembers, projects, users } from '../db/schema.js';
import {
  type ConversationAdapter,
  conversationParticipants,
  conversations,
} from '../db/schema-conversations.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import { personName } from '../lib/person-name.js';
import type { Executor, TxOnly } from './db-executor.js';
import { existingProjectHandle, handleNameForProject, unmintedOpening } from './handles.js';
import { conversationTransport } from './ports.js';
import { roomRefusal } from './room-refusal.js';
import { appendMessagesIn } from './store.js';

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
  /** When they first joined an organization the room's projects are in, which orders the unnamed (ISS-1229 r28). */
  addedAt: Date;
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
  /** False for a project's agent that no longer holds a role on it: offered marked, never added. */
  reachable: boolean;
  /** The `RoomOpener.blocked` reading of its project, so a taken address is marked too (ISS-1229 r37). */
  blocked: 'lost-role' | 'taken' | null;
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

/** How a room names a person: what `personName` calls them, never their address (ISS-1229). */
export async function personLabel(tx: Executor, userId: string): Promise<string> {
  const [row] = await tx
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return personName(row?.displayName, 'start');
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
 * A person may be added only where they could have read the room already, and only a person with an
 * account: an id that is none is refused as that, never as a missing role (ISS-1229 r28).
 */
export async function assertPersonReachesScope(
  conversationId: string,
  userId: string,
  scope: readonly string[],
  tx: Executor = defaultDb,
): Promise<void> {
  const [account] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) {
    throw roomRefusal(
      400,
      'PERSON_NOT_FOUND',
      'No Forge account has the id given for the person, so nobody was added to this room',
      { conversationId, userId },
    );
  }
  for (const projectId of scope) {
    const access = await effectiveProjectRole(userId, projectId);
    if (access?.role) continue;
    const [named] = await projectsNamed([projectId], tx);
    throw roomRefusal(
      400,
      'PERSON_OUT_OF_SCOPE',
      `This room is read only by somebody holding a role on every project it is about, and that person holds none on ${named ? `the project ${named.name}` : 'one of them'}; give them a role there first`,
      { conversationId, userId, projectId },
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
    .select({
      userId: users.id,
      email: users.email,
      addedAt: min(organizationMembers.createdAt).mapWith(organizationMembers.createdAt),
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(inArray(organizationMembers.orgId, orgIds), ne(users.kind, 'agent')))
    .groupBy(users.id, users.email);

  const out: PersonCandidate[] = [];
  for (const person of pool) {
    if (already.has(person.userId)) continue;
    let reaches = true;
    for (const projectId of scope) {
      if (!(await effectiveProjectRole(person.userId, projectId))?.role) reaches = false;
    }
    if (reaches && person.addedAt) out.push({ ...person, addedAt: person.addedAt });
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
    .select({ id: projects.id, name: projects.name, slug: projects.slug, orgId: projects.orgId })
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
  for (const { orgId, ...project } of candidateProjects) {
    const access = await effectiveProjectRole(actorUserId, project.id);
    if (!projectRoleAtLeast(access?.role ?? null, 'member')) continue;

    const losesReaderIds = scope.includes(project.id)
      ? []
      : await peopleWithoutRoleOn(livePeople, project.id);

    const mine = agents.filter((a) => a.projectId === project.id && a.handle);
    if (mine.length === 0) {
      if (scope.includes(project.id)) continue;
      // The address the project's agent would be minted under may already be answered: by its own agent
      // that lost its role there (r35), or by another agent, whose row would otherwise show the same
      // handle unmarked (r37). The reading `roomOpeners` and the mint's refusal share.
      const opening = await unmintedOpening(tx, { ...project, orgId });
      if (opening.kind === 'lost-role' && already.has(opening.userId)) continue;
      const blocked = opening.kind === 'mint' ? null : opening.kind;
      out.push({
        userId: opening.kind === 'lost-role' ? opening.userId : null,
        handle: opening.handle,
        project,
        losesReaderIds,
        reachable: blocked === null,
        blocked,
      });
      continue;
    }
    for (const agent of mine) {
      if (already.has(agent.userId)) continue;
      out.push({
        userId: agent.userId,
        handle: agent.handle as string,
        project,
        losesReaderIds,
        reachable: true,
        blocked: null,
      });
    }
  }
  return out.sort((a, b) => a.handle.localeCompare(b.handle));
}

/**
 * A project a room could be opened on, the agent it would start with, and whether opening it would
 * succeed: `blocked` names why not, the agent having lost its role there or its address being another
 * agent's, as `resolveProjectHandle` would refuse it.
 */
export interface RoomOpener {
  projectId: string;
  handle: string;
  reachable: boolean;
  blocked: 'lost-role' | 'taken' | 'nameless' | null;
}

/**
 * Every project this caller may open a room on (the member role or above, not archived), each with the
 * handle of its own agent and whether that agent still holds its role there, so a room that could only
 * be refused is marked before it is picked (ISS-1229 r36, judge-97). An agent not minted yet answers.
 */
export async function roomOpeners(
  actorUserId: string,
  tx: Executor = defaultDb,
): Promise<RoomOpener[]> {
  const [byOrg, byProject] = await Promise.all([
    tx
      .select({ id: projects.id, slug: projects.slug, orgId: projects.orgId })
      .from(projects)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, projects.orgId),
          eq(organizationMembers.userId, actorUserId),
        ),
      )
      .where(isNull(projects.archivedAt)),
    tx
      .select({ id: projects.id, slug: projects.slug, orgId: projects.orgId })
      .from(projects)
      .innerJoin(
        projectMembers,
        and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, actorUserId)),
      )
      .where(isNull(projects.archivedAt)),
  ]);
  const seen = new Set<string>();
  const out: RoomOpener[] = [];
  for (const project of [...byOrg, ...byProject]) {
    if (seen.has(project.id)) continue;
    seen.add(project.id);
    const access = await effectiveProjectRole(actorUserId, project.id);
    if (!projectRoleAtLeast(access?.role ?? null, 'member')) continue;
    const existing = await existingProjectHandle(tx, project.id);
    if (existing) {
      // An agent carrying no handle is refused HANDLE_HAS_NO_NAME by `namedHandle` on opening.
      const nameless = !existing.handle;
      out.push({
        projectId: project.id,
        handle: existing.handle ?? handleNameForProject(project.slug, project.id),
        reachable: !nameless,
        blocked: nameless ? 'nameless' : null,
      });
      continue;
    }
    const opening = await unmintedOpening(tx, project);
    const blocked = opening.kind === 'mint' ? null : opening.kind;
    out.push({ projectId: project.id, handle: opening.handle, reachable: !blocked, blocked });
  }
  return out;
}

/**
 * The projects of the room's organization whose agent this caller cannot add, for holding less than a
 * member role on them: named where the caller holds the viewer role, which already shows them the
 * project, and only counted where they hold none (ISS-1229 r33, judge-92). Every project has its own
 * agent, minted on its first add, so none is left out for having no agent row yet.
 */
export interface BeyondReach {
  named: NamedProject[];
  unnamed: number;
}

export async function agentsBeyondReach(
  actorUserId: string,
  scope: readonly string[],
  tx: Executor = defaultDb,
): Promise<BeyondReach> {
  const orgIds = await orgsOfProjects(scope, tx);
  const out: BeyondReach = { named: [], unnamed: 0 };
  if (orgIds.length === 0) return out;
  const others = await tx
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.orgId, orgIds));
  for (const project of others) {
    if (scope.includes(project.id)) continue;
    const role = (await effectiveProjectRole(actorUserId, project.id))?.role ?? null;
    if (projectRoleAtLeast(role, 'member')) continue;
    if (role === null) out.unnamed += 1;
    else out.named.push(project);
  }
  out.named.sort((a, b) => a.name.localeCompare(b.name));
  return out;
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
