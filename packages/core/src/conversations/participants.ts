// Who is in a conversation: people, and the handles that give it its scope.
//
// Membership is the authorization. A handle may be added only by somebody who
// already holds a role on that handle's project, and a room is readable only by
// somebody holding a role on every project its handles derive — so nothing here
// asks a per-message question that `scope.ts` cannot answer from the join.

import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { patIsLive } from '../auth/pat-live.js';
import { db as defaultDb } from '../db/client.js';
import {
  organizationMembers,
  personalAccessTokens,
  projectMembers,
  projects,
  users,
} from '../db/schema.js';
import {
  type ConversationParticipantKind,
  conversationMessages,
  conversationParticipants,
  conversations,
} from '../db/schema-conversations.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import type { Executor, TxOnly } from './db-executor.js';
import { resolveProjectHandle } from './handles.js';
import { roomRefusal } from './room-refusal.js';

export interface ParticipantRow {
  id: string;
  kind: ConversationParticipantKind;
  userId: string | null;
  /** The project a handle was added for; null for a person. */
  projectId: string | null;
  externalKey: string | null;
  label: string | null;
  /**
   * Whether this handle can still act — it holds a live credential and the
   * authority its room's project needs.
   */
  reachable: boolean | null;
  /** When this member was added; what tells apart two people who read the same name (ISS-1229 r24). */
  addedAt: Date;
}

export async function listParticipants(
  conversationId: string,
  tx: Executor = defaultDb,
): Promise<ParticipantRow[]> {
  const live = tx
    .select({ userId: personalAccessTokens.userId, n: count().as('n') })
    .from(personalAccessTokens)
    .where(patIsLive())
    .groupBy(personalAccessTokens.userId)
    .as('live');

  const rows = await tx
    .select({
      id: conversationParticipants.id,
      kind: conversationParticipants.kind,
      userId: conversationParticipants.userId,
      projectId: conversationParticipants.projectId,
      externalKey: conversationParticipants.externalKey,
      label: conversationParticipants.label,
      addedAt: conversationParticipants.addedAt,
      liveTokens: live.n,
      memberRole: projectMembers.role,
    })
    .from(conversationParticipants)
    .leftJoin(live, eq(live.userId, conversationParticipants.userId))
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.userId, conversationParticipants.userId),
        eq(projectMembers.projectId, conversationParticipants.projectId),
      ),
    )
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        isNull(conversationParticipants.removedAt),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    userId: row.userId,
    projectId: row.projectId,
    externalKey: row.externalKey,
    label: row.label,
    reachable: row.kind === 'handle' ? (row.liveTokens ?? 0) > 0 && row.memberRole !== null : null,
    addedAt: row.addedAt,
  }));
}

/** The projects a handle's scope comes from. */
export async function projectsOfHandle(
  handleUserId: string,
  tx: Executor = defaultDb,
): Promise<string[]> {
  const rows = await tx
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, handleUserId));
  return rows.map((r) => r.projectId).sort();
}

/** A room's live handles with the name each answers to; `handle` is null where the org has minted none yet. */
export interface RoomHandle {
  userId: string;
  handle: string | null;
}

export async function roomHandles(
  conversationId: string,
  tx: Executor = defaultDb,
): Promise<RoomHandle[]> {
  const rows = await tx
    .select({ userId: conversationParticipants.userId, handle: organizationMembers.handle })
    .from(conversationParticipants)
    .leftJoin(organizationMembers, eq(organizationMembers.userId, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.kind, 'handle'),
        isNull(conversationParticipants.removedAt),
      ),
    );
  const byUser = new Map<string, RoomHandle>();
  for (const r of rows) {
    if (!r.userId) continue;
    const seen = byUser.get(r.userId);
    if (!seen || (seen.handle === null && r.handle)) {
      byUser.set(r.userId, { userId: r.userId, handle: r.handle ?? null });
    }
  }
  return [...byUser.values()];
}

/**
 * How many people this room holds, for deciding whether a reply must say whom it answers.
 */
export async function personCount(
  conversationId: string,
  tx: Executor = defaultDb,
): Promise<number> {
  const [registered] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.kind, 'person'),
        isNull(conversationParticipants.removedAt),
      ),
    );
  const [spoken] = await tx
    .select({
      n: sql<number>`count(distinct coalesce(${conversationMessages.authorUserId}::text, ${conversationMessages.authorKey}, ${conversationMessages.authorLabel}))::int`,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.role, 'user'),
      ),
    );
  return Math.max(registered?.n ?? 0, spoken?.n ?? 0);
}

export async function handleForProject(
  conversationId: string,
  projectId: string,
  tx: Executor = defaultDb,
): Promise<string | null> {
  const [row] = await tx
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .innerJoin(projectMembers, eq(projectMembers.userId, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.kind, 'handle'),
        isNull(conversationParticipants.removedAt),
        eq(projectMembers.projectId, projectId),
      ),
    )
    .orderBy(conversationParticipants.addedAt)
    .limit(1);
  return row?.userId ?? null;
}

export interface AddHandleArgs {
  conversationId: string;
  /** The agent asked for; absent, the project's own agent, reused or minted. */
  handleUserId?: string;
  /**
   * Which of the handle's projects this room is about. Recorded on the row and
   * checked against both the handle's membership and the caller's role.
   */
  projectId: string;
  /** Who is doing the adding; their roles are what the door checks. */
  actorUserId: string;
  tx?: Executor;
}

async function loadHandle(
  tx: Executor,
  handleUserId: string,
): Promise<{ id: string; handle: string }> {
  const [row] = await tx
    .select({ id: users.id, kind: users.kind, handle: organizationMembers.handle })
    .from(users)
    .leftJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .where(eq(users.id, handleUserId))
    .limit(1);
  if (!row) {
    throw roomRefusal(
      400,
      'HANDLE_NOT_FOUND',
      'The agent asked for is no account here, so nobody was added to this room',
      { handleUserId },
    );
  }
  if (row.kind !== 'agent') {
    throw roomRefusal(
      400,
      'HANDLE_NOT_AN_AGENT',
      'The account asked for is a person, not an agent; an agent joins a room as an agent and a person joins it as a person',
      { handleUserId },
    );
  }
  if (!row.handle) {
    throw roomRefusal(
      400,
      'HANDLE_HAS_NO_NAME',
      'The agent asked for carries no handle in its organization, so there is no address to put in this room',
      { handleUserId },
    );
  }
  return { id: row.id, handle: row.handle };
}

/**
 * Put a handle in a room with NO authorization check, because there is nobody
 * to check: the room is being opened by a message arriving, not by a person.
 */
export async function attachOpeningHandle(
  tx: Executor,
  conversationId: string,
  handleUserId: string,
  projectId: string,
): Promise<void> {
  const handle = await loadHandle(tx, handleUserId);

  const handleProjects = await projectsOfHandle(handleUserId, tx);
  if (!handleProjects.includes(projectId)) {
    throw roomRefusal(
      400,
      'HANDLE_NOT_ON_PROJECT',
      `@${handle.handle} is not a member of this room's project, so it cannot be the opening agent for a room about that project`,
      { conversationId, handleUserId, projectId, handleProjectIds: handleProjects },
    );
  }

  await tx
    .insert(conversationParticipants)
    .values({
      conversationId,
      kind: 'handle',
      userId: handle.id,
      projectId,
      addedBy: null,
      label: handle.handle,
    })
    .onConflictDoNothing();
}

/**
 * Put a handle in a live room on somebody's behalf. This is the moment a room's
 * scope widens, so it is the moment the authorization is checked.
 */
export async function addHandle(args: AddHandleArgs): Promise<void> {
  const tx = args.tx ?? defaultDb;
  // Before any agent is looked up or minted: an agent of a deleted project is refused for its
  // project, never as an agent that is not on it (ISS-1229 r29, judge-84).
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, args.projectId))
    .limit(1);
  if (!project) {
    throw roomRefusal(
      404,
      'PROJECT_GONE',
      'The project this agent would bring into this room no longer exists, so there is no agent of it to add',
      { conversationId: args.conversationId, projectId: args.projectId },
    );
  }
  const handleUserId = args.handleUserId ?? (await resolveProjectHandle(tx, args.projectId)).userId;
  const handle = await loadHandle(tx, handleUserId);

  const handleProjects = await projectsOfHandle(handleUserId, tx);
  if (!handleProjects.includes(args.projectId)) {
    throw roomRefusal(
      400,
      'HANDLE_NOT_ON_PROJECT',
      `@${handle.handle} is not a member of the project it would bring into this room, so it cannot be the agent for a room about that project`,
      {
        conversationId: args.conversationId,
        handleUserId,
        projectId: args.projectId,
        handleProjectIds: handleProjects,
      },
    );
  }

  const access = await effectiveProjectRole(args.actorUserId, args.projectId);
  if (!projectRoleAtLeast(access?.role ?? null, 'member')) {
    throw roomRefusal(
      403,
      'HANDLE_PROJECT_FORBIDDEN',
      `@${handle.handle} would make this room about a project on which you hold ${access?.role ? `the ${access.role} role` : 'no role'}; an agent is added to a room by somebody who holds at least a member role on its project`,
      { conversationId: args.conversationId, projectId: args.projectId },
    );
  }

  await tx
    .insert(conversationParticipants)
    .values({
      conversationId: args.conversationId,
      kind: 'handle',
      userId: handleUserId,
      projectId: args.projectId,
      addedBy: args.actorUserId,
      label: handle.handle,
    })
    .onConflictDoNothing();
}

export interface AddPersonArgs {
  conversationId: string;
  userId?: string | null;
  externalKey?: string | null;
  label?: string | null;
  actorUserId?: string | null;
  tx?: Executor;
}

export async function addPerson(args: AddPersonArgs): Promise<void> {
  const tx = args.tx ?? defaultDb;
  if (!args.userId && !args.externalKey) {
    throw roomRefusal(
      400,
      'PARTICIPANT_UNIDENTIFIED',
      'Nobody was added to this room: a person joins it as a Forge account or as the key their channel gave, and neither was given',
      { conversationId: args.conversationId },
    );
  }
  await tx
    .insert(conversationParticipants)
    .values({
      conversationId: args.conversationId,
      kind: 'person',
      userId: args.userId ?? null,
      externalKey: args.externalKey ?? null,
      label: args.label ?? null,
      addedBy: args.actorUserId ?? null,
    })
    .onConflictDoNothing();
}

export interface RemoveParticipantArgs {
  conversationId: string;
  participantId: string;
  /**
   * Join the caller's OPEN transaction — the caller is then the one serializing. Typed `TxOnly`
   * and not `Executor` on purpose: handing a pool to a parameter named `tx` compiles, and then the
   * `FOR UPDATE` below holds its lock for one statement instead of for the check it guards.
   */
  tx?: TxOnly;
  /** Or open one of this module's own, on this pool. */
  db?: typeof defaultDb;
}

/** Stamp a participant as gone. */
export async function removeParticipant(args: RemoveParticipantArgs): Promise<void> {
  if (args.tx) return removeWithin(args.tx, args);
  const dbi = args.db ?? defaultDb;
  return dbi.transaction((tx) => removeWithin(tx as unknown as Executor, args));
}

async function removeWithin(tx: Executor, args: RemoveParticipantArgs): Promise<void> {
  const [room] = await tx
    .select({ id: conversations.id, shape: conversations.shape })
    .from(conversations)
    .where(eq(conversations.id, args.conversationId))
    .for('update')
    .limit(1);

  const [row] = await tx
    .select({ id: conversationParticipants.id, kind: conversationParticipants.kind })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.id, args.participantId),
        eq(conversationParticipants.conversationId, args.conversationId),
        isNull(conversationParticipants.removedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw roomRefusal(
      404,
      'NOT_FOUND',
      'Whoever was asked for is not in this room, so nobody was taken out of it',
      { conversationId: args.conversationId, participantId: args.participantId },
    );
  }

  const liveOfKind = async (kind: ConversationParticipantKind): Promise<number> => {
    const [counted] = await tx
      .select({ live: sql<number>`count(*)::int` })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, args.conversationId),
          eq(conversationParticipants.kind, kind),
          isNull(conversationParticipants.removedAt),
        ),
      );
    return counted?.live ?? 0;
  };

  if (row.kind === 'handle' && (await liveOfKind('handle')) <= 1) {
    throw roomRefusal(
      400,
      'CONVERSATION_LAST_HANDLE',
      'This room has one agent left and a room with none is about no project, so nobody could read it again; add another agent first, or delete the room',
      { conversationId: args.conversationId, participantId: args.participantId },
    );
  }

  if (row.kind === 'person' && room?.shape === 'direct' && (await liveOfKind('person')) <= 1) {
    throw roomRefusal(
      400,
      'CONVERSATION_LAST_PERSON',
      'This room is a one-to-one room and this is the last person in it; such a room is read by the people in it, so taking the last one out would leave it readable by nobody — add another person first, or delete the room',
      { conversationId: args.conversationId, participantId: args.participantId },
    );
  }

  await tx
    .update(conversationParticipants)
    .set({ removedAt: new Date() })
    .where(eq(conversationParticipants.id, args.participantId));
}
