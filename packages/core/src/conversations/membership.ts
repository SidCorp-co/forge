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
// cm:guard NO display name on this row, and it is not an omission: `db/display-name-readers.test.ts` names this directory one by one as a place `users.display_name` may not be read, because the label is re-assignable and the address is not. What a person is CALLED is attached by the presentation module that answers the request, which is where a label belongs (ISS-1003, ISS-1011).
export interface PersonCandidate {
  userId: string;
  email: string;
}

export interface HandleCandidate {
  /**
   * The people already in this room who would lose it if this agent joined, by id.
   */
  // cm:guard a room is readable only by somebody holding a role on EVERY project in it, so bringing a new project in can put an existing member outside the room — quietly, and with nothing on the screen that said it would happen. Computed per candidate rather than described in general, because "somebody might lose access" is a warning nobody can act on and "Grace will lose this room" is. Ids, not labels: what to CALL them is attached in `assistant/conversation-people.ts`, which is the module allowed to read the label column (ISS-1011).
  losesReaderIds: string[];
  /**
   * The agent account, or null where this project has never needed one.
   */
  // cm:guard NULLABLE, because a project's handle is minted the first time a room needs it and not when the project is created: a candidate list built from `users` alone offers nothing for a project nobody has ever talked to, which is exactly the project somebody is now trying to bring into a room. The add resolves it, and `resolveProjectHandle` mints it there under the same lock it always has.
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
// cm:guard shape follows the HANDLE count and not the head count, which is the reading `schema-conversations.ts` already states: a direct room is one handle, a group room is several, and what a shape decides is addressing. A room where four colleagues talk to one project's agent is still that one agent's room, and calling it a group would widen its readers from the people in it to everyone holding a role on its project (ISS-1011).
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
// cm:guard `group` iff more than one handle OR more than one person, and the person half is what ISS-1034 added to ISS-1011's handle count: one person and one bot is a direct chat whoever is addressed, and a second person makes it a room. `null` for a room that records no persons — a channel adapter's room, whose membership is its channel's — because a count of zero people says nothing about how many are there (ISS-1034 criteria 41, 43, 45).
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
// cm:guard BOTH ways for a room whose transport says its shape follows its members and PROMOTION ONLY for a channel adapter's: a channel room's shape is settled when its venue is first seen and `assertVenueMatches` refuses a message arriving under another, so demoting one here would make the next message a conflict the room itself caused (ISS-987, ISS-1034 criterion 46). A Forge room reads its shape off the row on every request and can move.
// cm:guard the flip and the `system` row are written TOGETHER, and the row is written only when the caller says what changed: a reader who opens the thread and finds the room a group with nobody having said why has a transcript that lies by omission, while a room opened already holding two people has nothing to explain (ISS-1034 criteria 42, 43).
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
// cm:guard a NULL conversation is a room that does not exist yet and answers the empty set, because the candidate question is asked twice: once for a live room, and once by the screen that is about to open one and wants to know who it could open it with. Two functions would be two rules about who may be added, and they would drift (ISS-1011 criterion 39).
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
// cm:guard refused BY NAME and never by silently adding somebody the read check will turn away later: a person in the participant list who cannot open the room is a roster that lies, and the person who added them is told nothing. The refusal names the project they hold no role on, because that is the whole of what the adder has to fix (ISS-1011 criteria 7, 8).
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
// cm:guard the pool is the ORG's own members and never every user in the deployment: a directory that answered "anybody" would make this endpoint an existence oracle for accounts the caller has no business knowing about, and the set that could actually read the room is bounded by the orgs its projects belong to anyway.
export async function addablePeople(
  conversationId: string | null,
  scope: readonly string[],
  tx: Executor = defaultDb,
): Promise<PersonCandidate[]> {
  if (scope.length === 0) return [];
  const already = await liveUserIds(conversationId, tx);
  // cm:guard a room that does not exist yet opens holding the handle of every project in its scope, so that handle is already a member and is excluded BY IDENTITY — not by excluding its project, which would also hide a project's other agents and quietly drop a room anybody can still compose by adding them a moment later. Excluded here rather than deduplicated later because the cost is not the duplicate row, which `settleShape` absorbs: it is the sentence shown before the room opens, which counts handles and would promise a shared room where a one-to-one room is what gets created (ISS-1011).
  // cm:edge contract -> packages/core/src/conversations/handles.ts — `existingProjectHandle` is the same pick `resolveProjectHandle` makes, and the create path attaches whatever it returns; a change to that ordering has to reach this exclusion or the list offers the member the room is about to hold.
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
// cm:guard the set is what the CALLER may bring and not what the room could hold: `addHandle` refuses an actor holding less than a member role on the project the agent brings, so offering an agent the caller cannot add would be a list built to be refused. The bound is the orgs the room's projects already belong to — an agent from another org is a scope nobody in this room can reach (ISS-1011 criteria 9, 10).
export async function addableHandles(
  conversationId: string | null,
  actorUserId: string,
  scope: readonly string[],
  tx: Executor = defaultDb,
): Promise<HandleCandidate[]> {
  const already = await liveUserIds(conversationId, tx);
  // cm:guard a room that does not exist yet opens holding the handle of every project in its scope, so that handle is already a member and is excluded BY IDENTITY — not by excluding its project, which would also hide a project's other agents and quietly drop a room anybody can still compose by adding them a moment later. Excluded here rather than deduplicated later because the cost is not the duplicate row, which `settleShape` absorbs: it is the sentence shown before the room opens, which counts handles and would promise a shared room where a one-to-one room is what gets created (ISS-1011).
  // cm:edge contract -> packages/core/src/conversations/handles.ts — `existingProjectHandle` is the same pick `resolveProjectHandle` makes, and the create path attaches whatever it returns; a change to that ordering has to reach this exclusion or the list offers the member the room is about to hold.
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
    // cm:guard the SAME bar `addHandle` holds, read through the same helper: a candidate list built to a looser rule than the door is a list of agents the caller will be refused on.
    if (!projectRoleAtLeast(access?.role ?? null, 'member')) continue;

    // cm:guard asked only for a project the room is NOT already about, because a project already in the scope costs nobody their access: everyone still in the room has already passed the check for it.
    const losesReaderIds = scope.includes(project.id)
      ? []
      : await peopleWithoutRoleOn(livePeople, project.id);

    const mine = agents.filter((a) => a.projectId === project.id && a.handle);
    if (mine.length === 0) {
      // cm:guard a project with no agent yet is OFFERED under the name it will be given, rather than left out: leaving it out makes "which projects can this room be about" an answer about which projects happen to have been talked to before, which is not a rule anybody would state out loud. A project already in the scope is the exception, and for the plain reason that it is already there — there is nothing for a caller to bring.
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

// cm:guard one call per person per candidate project, and deliberately NOT a batched query of its own: the bar is whatever `effectiveProjectRole` says it is — the project role, the org-derived one above it, and the fence above both — and a second copy of that here would be a second answer to "may this person read this project" that nothing keeps in step. The cost is bounded by the people in ONE room times the projects the room is not yet about, and it is only paid on the candidate list; if a room large enough to feel it ever exists, batch it by teaching `authz` to answer for many projects at once rather than by re-deriving the rule here.
// cm:guard `viewer` and not `member`, because the bar this is predicting is the READ rule in `scope.ts:assertConversationRole` — asking the stricter question here would name people who keep the room, and a confirmation that overstates the damage is as false as one that hides it (ISS-1011).
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
