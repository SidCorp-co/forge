import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import type { ProjectMemberRole } from '../db/schema.js';
import { conversationParticipants, conversations } from '../db/schema-conversations.js';
import {
  effectiveProjectRole,
  loadOrgRole,
  orgRoleAtLeast,
  projectRoleAtLeast,
} from '../lib/authz.js';
import type { Executor } from './db-executor.js';
import { roomRefusal } from './room-refusal.js';

/**
 * The project ids this conversation is about, sorted so two reads of one
 * unchanged room compare equal.
 */
export async function derivedScope(
  conversationId: string,
  tx: Executor = defaultDb,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ projectId: conversationParticipants.projectId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.kind, 'handle'),
        isNull(conversationParticipants.removedAt),
        isNotNull(conversationParticipants.projectId),
      ),
    );
  return rows.flatMap((r) => (r.projectId ? [r.projectId] : [])).sort();
}

/**
 * The caller may read this conversation, or a refusal naming what is missing.
 * Returns the scope it checked, so a caller that needs it does not read twice.
 */
export async function assertConversationReadable(
  conversationId: string,
  userId: string | null | undefined,
  tx: Executor = defaultDb,
): Promise<string[]> {
  return assertConversationRole(conversationId, userId, 'viewer', tx);
}

/**
 * The caller may CHANGE this conversation — rename it, delete it — or a refusal.
 */
export async function assertConversationWritable(
  conversationId: string,
  userId: string | null | undefined,
  tx: Executor = defaultDb,
): Promise<string[]> {
  return assertConversationRole(conversationId, userId, 'member', tx);
}

async function assertConversationRole(
  conversationId: string,
  userId: string | null | undefined,
  min: ProjectMemberRole,
  tx: Executor = defaultDb,
): Promise<string[]> {
  if (!userId) {
    throw roomRefusal(
      403,
      'CONVERSATION_NO_AUTHORITY',
      'This room was reached with no authority named; a turn or a read names the user it runs as, and nothing here is anonymous',
      { conversationId },
    );
  }
  const scope = await derivedScope(conversationId, tx);
  if (scope.length === 0) {
    // A room about no project is still its organization's (ISS-1229 r23): whoever opened it, or an
    // admin of that organization, reaches it, to look at it and to delete it.
    const room = await roomAboutNoProject(conversationId, tx);
    if (room && (await holdsRoomAboutNoProject(room, userId, tx))) return [];
    throw roomRefusal(
      403,
      'CONVERSATION_NO_SCOPE',
      `This room has no agent in it, so it is about no project; ${whoReaches(room)} can reach it`,
      { conversationId },
    );
  }
  for (const projectId of scope) {
    const access = await effectiveProjectRole(userId, projectId);
    if (!projectRoleAtLeast(access?.role ?? null, min)) {
      throw roomRefusal(
        403,
        'CONVERSATION_OUT_OF_SCOPE',
        `This room is about a project on which you hold no ${min} role; a room is reached only by someone who holds one on every project in it`,
        { conversationId, projectId },
      );
    }
  }
  return scope;
}

interface RoomAboutNoProject {
  id: string;
  orgId: string | null;
  createdBy: string | null;
  shape: string;
}

async function roomAboutNoProject(
  conversationId: string,
  tx: Executor,
): Promise<RoomAboutNoProject | null> {
  const [room] = await tx
    .select({
      id: conversations.id,
      orgId: conversations.orgId,
      createdBy: conversations.createdBy,
      shape: conversations.shape,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return room ?? null;
}

/** Who a room about no project is reached by, in the words its refusal names them (ISS-1229 r25). */
function whoReaches(room: RoomAboutNoProject | null): string {
  if (room?.shape === 'direct') return 'it is a one-to-one room, so only the people in it';
  if (room && room.orgId === null)
    return 'no organization holds it, so only the person who opened it';
  return 'only the person who opened it or an admin of its organization';
}

/**
 * Whether this caller reaches a room about no project: a one-to-one room by the people in it alone,
 * whatever role they hold (ISS-1229 r25); any other by its opener or an admin of its organization.
 */
export async function holdsRoomAboutNoProject(
  room: RoomAboutNoProject,
  userId: string,
  tx: Executor = defaultDb,
): Promise<boolean> {
  if (room.shape === 'direct') return isOneOfItsPeople(room.id, userId, tx);
  if (room.createdBy === userId) return true;
  return room.orgId !== null && orgRoleAtLeast(await loadOrgRole(room.orgId, userId), 'admin');
}

async function isOneOfItsPeople(
  conversationId: string,
  userId: string,
  tx: Executor,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.kind, 'person'),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.removedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}
