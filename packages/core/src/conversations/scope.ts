// What a conversation is about: the projects its handles were added FOR.
//
// A room has no project of its own; it has the set its live handles carry. Each
// handle records that project at the door, because the door already resolved it
// to check the caller's role — so the room's scope is read back rather than
// recomputed from a table that answers a different question.
//
// It WAS recomputed, from `project_members`, which is the row revoking an agent
// deletes. A revoke therefore emptied the scope of every room where that agent
// was the only handle, and two correct rules closed on each other: an empty
// scope is refused to every reader, and a room's last handle may not be
// removed. No supported call reopened it (ISS-1003).

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db as defaultDb } from '../db/client.js';
import type { ProjectMemberRole } from '../db/schema.js';
import { conversationParticipants } from '../db/schema-conversations.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
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
    throw forbidden(
      `conversation ${conversationId} has no handle in it, so it is about no project and nobody holds a role that reaches it`,
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
