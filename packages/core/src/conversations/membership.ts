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
import { conversationParticipants, conversations } from '../db/schema-conversations.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import type { Executor } from './db-executor.js';
import { handleNameForProject } from './handles.js';

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

/**
 * Move a room's shape to match the handles now in it — upward only.
 */
// cm:guard PROMOTION only, and the asymmetry is deliberate rather than an omission. Promoting is a widening the caller was shown and confirmed. Demoting is not its mirror: `conversation-access.ts:assertInTheRoom` fences a `direct` room to its live people, and a group room may record none of its people at all, so narrowing one back would hand nobody a room everybody could read a moment ago. A room that has been about several projects stays a shared room (ISS-1011).
export async function settleShape(tx: Executor, conversationId: string): Promise<void> {
  const live = await tx
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.kind, 'handle'),
        isNull(conversationParticipants.removedAt),
      ),
    );
  if (shapeForHandleCount(live.length) !== 'group') return;
  await tx
    .update(conversations)
    .set({ shape: 'group' })
    .where(and(eq(conversations.id, conversationId), eq(conversations.shape, 'direct')));
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
  const orgIds = await orgsOfProjects(scope, tx);
  if (orgIds.length === 0) return [];

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

    const mine = agents.filter((a) => a.projectId === project.id && a.handle);
    if (mine.length === 0) {
      // cm:guard a project with no agent yet is OFFERED under the name it will be given, rather than left out: leaving it out makes "which projects can this room be about" an answer about which projects happen to have been talked to before, which is not a rule anybody would state out loud.
      if (!scope.includes(project.id)) {
        out.push({ userId: null, handle: handleNameForProject(project.slug, project.id), project });
      }
      continue;
    }
    for (const agent of mine) {
      if (already.has(agent.userId)) continue;
      out.push({ userId: agent.userId, handle: agent.handle as string, project });
    }
  }
  return out.sort((a, b) => a.handle.localeCompare(b.handle));
}

async function orgsOfProjects(ids: readonly string[], tx: Executor): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .selectDistinct({ orgId: projects.orgId })
    .from(projects)
    .where(inArray(projects.id, [...ids]));
  return rows.map((r) => r.orgId);
}
