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
// cm:guard read the PARTICIPANT's project and never join `project_members` again. ISS-1001's guard here refused a cached scope on the grounds that it would be a second copy of a membership a revocation does not reach, and it was right about a cache — but the column this reads is not one: `project_members` answers what the agent may DO and `conversation_participants.project_id` answers what the ROOM is about, and it was folding those two questions into one row that let a revoke empty a room (ISS-1003). Authority is still read live, below, through `effectiveProjectRole` on every project in the set — which is the half that must never be cached.
// cm:guard a REMOVED handle is excluded and a room with no live handle still derives the empty set that `assertConversationRole` refuses. That refusal is not the defect this replaced: a room really about nothing is readable by nobody, and `participants.ts:removeParticipant` is what stops a caller creating one.
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
// cm:guard an EMPTY scope is refused, never granted: the check is "a role on every project in the set", and an `every` over nothing is true — so a room whose last handle went would become readable by anyone rather than by nobody. `participants.ts` refuses the removal that would create one, and this is the second half of that pair (ISS-1001 criteria 11, 42).
export async function assertConversationReadable(
  conversationId: string,
  userId: string | null | undefined,
): Promise<string[]> {
  return assertConversationRole(conversationId, userId, 'viewer');
}

/**
 * The caller may CHANGE this conversation — rename it, delete it — or a refusal.
 */
// cm:guard writing takes `member` on every project in the room, and reading takes `viewer`: a viewer is somebody who may look at a project, and renaming or deleting a shared room is not looking. Opening one already takes `member`, so a read-level write check would make the rules disagree with each other — the cheaper one winning (ISS-1001).
export async function assertConversationWritable(
  conversationId: string,
  userId: string | null | undefined,
): Promise<string[]> {
  return assertConversationRole(conversationId, userId, 'member');
}

async function assertConversationRole(
  conversationId: string,
  userId: string | null | undefined,
  min: ProjectMemberRole,
): Promise<string[]> {
  // cm:guard a caller naming NO user forgot to, and is refused as that rather than as "you hold no role": reading null as an anonymous reader made one missing argument silence every room
  if (!userId) {
    throw forbidden(
      `conversation ${conversationId} was reached with no authority named; a turn or a read names the user it runs as, and nothing here is anonymous`,
      'CONVERSATION_NO_AUTHORITY',
    );
  }
  const scope = await derivedScope(conversationId);
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
