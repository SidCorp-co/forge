// What a conversation is about, derived and never stored.
//
// A room has no project of its own. Its scope is the union of the projects its
// handle participants belong to, computed at the moment of the read — so a role
// revoked after somebody joined takes the room with it, with no write anywhere
// and nothing to miss.

import { and, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db as defaultDb } from '../db/client.js';
import type { ProjectMemberRole } from '../db/schema.js';
import { projectMembers } from '../db/schema.js';
import { conversationParticipants } from '../db/schema-conversations.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import type { Executor } from './db-executor.js';

const forbidden = (message: string, code: string) =>
  new HTTPException(403, { message, cause: { code } });

/**
 * The project ids this conversation is about, sorted so two reads of one
 * unchanged room compare equal.
 */
// cm:guard the join is the whole authorization story and there is no cache of it: a `project_id` on the conversation, or a materialized scope column, is a second copy of a membership that a revocation does not reach — which is the state ISS-1001 invariant 2 exists to remove. Add one only with its invalidation, and price it.
export async function derivedScope(
  conversationId: string,
  tx: Executor = defaultDb,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ projectId: projectMembers.projectId })
    .from(conversationParticipants)
    .innerJoin(projectMembers, eq(projectMembers.userId, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.kind, 'handle'),
        isNull(conversationParticipants.removedAt),
      ),
    );
  return rows.map((r) => r.projectId).sort();
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
  // cm:guard a caller naming NO user forgot to, and is refused as that rather than as "you hold no
  // role": reading null as an anonymous reader made one missing argument silence every room
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
