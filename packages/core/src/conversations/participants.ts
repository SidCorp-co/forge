// Who is in a conversation: people, and the handles that give it its scope.
//
// Membership is the authorization. A handle may be added only by somebody who
// already holds a role on that handle's project, and a room is readable only by
// somebody holding a role on every project its handles derive — so nothing here
// asks a per-message question that `scope.ts` cannot answer from the join.

import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { patIsLive } from '../auth/pat-live.js';
import { db as defaultDb } from '../db/client.js';
import { organizationMembers, personalAccessTokens, projectMembers, users } from '../db/schema.js';
import {
  type ConversationParticipantKind,
  conversationParticipants,
  conversations,
} from '../db/schema-conversations.js';
import { effectiveProjectRole } from '../lib/authz.js';
import type { Executor, TxOnly } from './db-executor.js';

const forbidden = (message: string, code: string) =>
  new HTTPException(403, { message, cause: { code } });

const badRequest = (message: string, code: string) =>
  new HTTPException(400, { message, cause: { code } });

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
  // cm:guard a handle that cannot act is REPORTED and never hidden, and the room stays readable around it. Revoking an agent is a security action that always succeeds; what it must not do is make the room silently go quiet, which is what an empty scope did before the project moved onto this row (ISS-1003 criteria 18, 20). `null` for a person, who is not a thing that acts.
  reachable: boolean | null;
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
    // cm:guard BOTH halves, because either alone leaves a handle that cannot act reading as if it could: a credential with no membership reaches nothing, and a membership with no credential has nothing to reach with. `revokeAgentAccount` removes both and `revokeAgentCredentials` removes only the first, so a reader testing one of them would call an agent reachable after one of the two revokes.
    reachable: row.kind === 'handle' ? (row.liveTokens ?? 0) > 0 && row.memberRole !== null : null,
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

/**
 * The live handle in this room that carries `projectId`, or null where none does.
 */
// cm:guard who an assistant message in this room is BY: a room may hold several handles, and the one that speaks is the one carrying the project the turn arrived under (ISS-1001 criterion 14)
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
  handleUserId: string;
  /**
   * Which of the handle's projects this room is about. Recorded on the row and
   * checked against both the handle's membership and the caller's role.
   */
  // cm:guard NAMED by the caller and never inferred from the handle's memberships, even though an agent holds exactly one today. The value is what the room's scope is read from for the rest of its life, so inferring it binds the room to whatever the agent's memberships happen to be at the moment of the add — and a second membership granted a month later would then silently widen every room the inference had touched (ISS-1003 criterion 21). One project, named, is also the only shape the stored column can hold.
  projectId: string;
  /** Who is doing the adding; their roles are what the door checks. */
  actorUserId: string;
  tx?: Executor;
}

// cm:guard the handle is READ from `organization_members.handle` and never split back out of the address (ISS-1003). The join is `leftJoin` and the null is refused by name rather than fallen back on, because an agent whose membership carries no handle is a row 0242 could not have produced — reaching for `email.split('.')` there would put the second spelling back, and the suffix in the address is exactly what makes the two disagree.
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
    throw badRequest(`no user ${handleUserId}, so it is no handle`, 'HANDLE_NOT_FOUND');
  }
  if (row.kind !== 'agent') {
    throw badRequest(
      `user ${handleUserId} is a person, not an agent; a handle is an agent account and a person joins as a person`,
      'HANDLE_NOT_AN_AGENT',
    );
  }
  if (!row.handle) {
    throw badRequest(
      `agent ${handleUserId} carries no handle on its org membership, so there is no address to put in a room`,
      'HANDLE_HAS_NO_NAME',
    );
  }
  return { id: row.id, handle: row.handle };
}

/**
 * Put a handle in a room with NO authorization check, because there is nobody
 * to check: the room is being opened by a message arriving, not by a person.
 */
// cm:guard the ONLY caller is `store.ts:openConversation`, in the same transaction that inserts the conversation, and that is what keeps this unchecked path safe: the handle it attaches is the one the venue's own project resolves to, never one a caller named. A route, a tool or an adapter reaching for this instead of `addHandle` is a handle admitted with nobody's role behind it — which is the door standing open (ISS-1001 criteria 8, 9, 13).
// cm:guard `projectId` is the VENUE's project, passed in rather than derived from the handle's memberships, and that is the same rule `addHandle` follows for a different reason: the room is about the project the message arrived under, and reading it off the agent instead would make a second membership granted later change what an already-open room is about (ISS-1003 criterion 21).
export async function attachOpeningHandle(
  tx: Executor,
  conversationId: string,
  handleUserId: string,
  projectId: string,
): Promise<void> {
  const handle = await loadHandle(tx, handleUserId);
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
// cm:guard checked at the DOOR and per PROJECT: a handle carries its projects with it, so admitting one a caller holds no role on hands them a room whose answers are computed with an access they do not have. The refusal names the project rather than saying no, because "which of its projects" is the whole of what the caller has to fix (ISS-1001 criteria 8, 9).
// cm:guard `actorUserId` is REQUIRED and not nullable, because the check is `effectiveProjectRole(actor, …)` and an absent actor holds no role anywhere: made optional, every caller that forgets to pass one is refused on a room it owns, and the obvious fix — skipping the loop when it is absent — turns the door into a formality. The opening path has `attachOpeningHandle` instead, which says out loud that it checks nothing.
export async function addHandle(args: AddHandleArgs): Promise<void> {
  const tx = args.tx ?? defaultDb;
  const handle = await loadHandle(tx, args.handleUserId);

  // cm:guard the named project must be one the HANDLE holds, checked before the caller's role is: a project the agent is no member of is a room whose scope names work that agent cannot do, and admitting it would put a handle in a room it can never answer in. Refused by name rather than corrected to the agent's actual project, because which project the room is about is the caller's decision and not this function's to guess.
  const handleProjects = await projectsOfHandle(args.handleUserId, tx);
  if (!handleProjects.includes(args.projectId)) {
    throw badRequest(
      `@${handle.handle} is a member of ${handleProjects.length === 0 ? 'no project' : handleProjects.join(', ')} and not of ${args.projectId}, so it cannot be the handle for a room about that project`,
      'HANDLE_NOT_ON_PROJECT',
    );
  }

  const access = await effectiveProjectRole(args.actorUserId, args.projectId);
  if (!access?.role) {
    throw forbidden(
      `@${handle.handle} would make this room about project ${args.projectId} and you hold no role on it; a handle is added to a room by somebody who holds a role on its project`,
      'HANDLE_PROJECT_FORBIDDEN',
    );
  }

  await tx
    .insert(conversationParticipants)
    .values({
      conversationId: args.conversationId,
      kind: 'handle',
      userId: args.handleUserId,
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

// cm:guard a person may join with NO `users` row — an unlinked speaker has only the key their adapter gave, which is what `chat_sessions.user_key` held. That key authorizes nothing: `assistant_speaker_links` stays the only path from an outside speaker to a Forge identity.
export async function addPerson(args: AddPersonArgs): Promise<void> {
  const tx = args.tx ?? defaultDb;
  if (!args.userId && !args.externalKey) {
    throw badRequest(
      'a person joins a conversation as a Forge user or as the key their channel gave; with neither there is nobody to add',
      'PARTICIPANT_UNIDENTIFIED',
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
// cm:guard the LAST handle may not leave: a room with none derives an empty scope, and `scope.ts` then refuses every reader — so the removal does not fail loudly, it makes the room silently unreachable for everybody including the person who removed it. Atomic creation holds the invariant only until the first removal; this is the other half (ISS-1001 criterion 42).
// cm:guard the count and the update are ONE transaction behind a `FOR UPDATE` on the conversation, because the check is a read-then-write across two handles: two callers removing a different handle each count two, each pass `live <= 1`, and both commit — leaving exactly the unreadable room this guard exists to prevent, with neither caller told.
export async function removeParticipant(args: RemoveParticipantArgs): Promise<void> {
  if (args.tx) return removeWithin(args.tx, args);
  const dbi = args.db ?? defaultDb;
  return dbi.transaction((tx) => removeWithin(tx as unknown as Executor, args));
}

async function removeWithin(tx: Executor, args: RemoveParticipantArgs): Promise<void> {
  await tx
    .select({ id: conversations.id })
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
    throw new HTTPException(404, {
      message: `no live participant ${args.participantId} in conversation ${args.conversationId}`,
      cause: { code: 'NOT_FOUND' },
    });
  }

  if (row.kind === 'handle') {
    const [{ live } = { live: 0 }] = await tx
      .select({ live: sql<number>`count(*)::int` })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, args.conversationId),
          eq(conversationParticipants.kind, 'handle'),
          isNull(conversationParticipants.removedAt),
        ),
      );
    if (live <= 1) {
      throw badRequest(
        `conversation ${args.conversationId} has one handle left and a room with none is about no project, so nobody could read it again; add another handle first, or delete the conversation`,
        'CONVERSATION_LAST_HANDLE',
      );
    }
  }

  await tx
    .update(conversationParticipants)
    .set({ removedAt: new Date() })
    .where(eq(conversationParticipants.id, args.participantId));
}
