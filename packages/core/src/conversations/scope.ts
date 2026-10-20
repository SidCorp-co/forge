import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
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

const forbidden = (message: string, code: string) =>
  new HTTPException(403, { message, cause: { code } });

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
    throw forbidden(
      `conversation ${conversationId} was reached with no authority named; a turn or a read names the user it runs as, and nothing here is anonymous`,
      'CONVERSATION_NO_AUTHORITY',
    );
  }
  const scope = await derivedScope(conversationId, tx);
  if (scope.length === 0) {
    // A room about no project is still its organization's (ISS-1229 r23): whoever opened it, or an
    // admin of that organization, reaches it, to look at it and to delete it.
    if (await holdsRoomAboutNoProject(conversationId, userId, tx)) return [];
    throw forbidden(
      `conversation ${conversationId} has no agent in it, so it is about no project; only the person who opened it or an admin of its organization can reach it`,
      'CONVERSATION_NO_SCOPE',
    );
  }
  for (const projectId of scope) {
    const access = await effectiveProjectRole(userId, projectId);
    if (!projectRoleAtLeast(access?.role ?? null, min)) {
      throw forbidden(
        `conversation ${conversationId} is about project ${projectId} and you hold no ${min} role on it; a room is reached only by someone who holds one on every project in it`,
        'CONVERSATION_OUT_OF_SCOPE',
      );
    }
  }
  return scope;
}

/** Whether this caller opened the room or holds the admin role in the organization it belongs to. */
export async function holdsRoomAboutNoProject(
  conversationId: string,
  userId: string,
  tx: Executor = defaultDb,
): Promise<boolean> {
  const [room] = await tx
    .select({ orgId: conversations.orgId, createdBy: conversations.createdBy })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!room) return false;
  if (room.createdBy === userId) return true;
  return room.orgId !== null && orgRoleAtLeast(await loadOrgRole(room.orgId, userId), 'admin');
}
