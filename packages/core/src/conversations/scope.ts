import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { conversationParticipants } from '../db/schema-conversations.js';
import { forbidden } from '../middleware/route-errors.js';
import {
  actorFor,
  can,
  type ProjectPermission,
  projectResource,
  requireCan,
} from '../permissions/index.js';
import type { Executor } from './db-executor.js';

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
 * Each conversation's derived scope (`derivedScope`), for many rooms in one read: a room with no
 * live handle maps to an empty scope.
 */
export async function derivedScopes(
  conversationIds: readonly string[],
  tx: Executor = defaultDb,
): Promise<Map<string, string[]>> {
  const scopes = new Map(conversationIds.map((id) => [id, [] as string[]]));
  if (conversationIds.length === 0) return scopes;
  const rows = await tx
    .selectDistinct({
      conversationId: conversationParticipants.conversationId,
      projectId: conversationParticipants.projectId,
    })
    .from(conversationParticipants)
    .where(
      and(
        inArray(conversationParticipants.conversationId, [...conversationIds]),
        eq(conversationParticipants.kind, 'handle'),
        isNull(conversationParticipants.removedAt),
        isNotNull(conversationParticipants.projectId),
      ),
    );
  for (const r of rows) if (r.projectId) scopes.get(r.conversationId)?.push(r.projectId);
  for (const scope of scopes.values()) scope.sort();
  return scopes;
}

/**
 * The rooms among these a caller sees listed: each project a room's handles derive is one the
 * caller reads, and a direct room holds the caller as a person. Two reads for any number of rooms,
 * and one permission check per project: a read per room made opening the dock on a project with
 * hundreds of rooms wait seconds on "Opening your latest conversation…" (ISS-1006 round 2).
 */
export async function listableRooms<R extends { id: string; shape: string }>(
  rooms: readonly R[],
  userId: string,
  tx: Executor = defaultDb,
): Promise<R[]> {
  const ids = rooms.map((r) => r.id);
  const direct = rooms.filter((r) => r.shape === 'direct').map((r) => r.id);
  const [scopes, joined] = await Promise.all([
    derivedScopes(ids, tx),
    direct.length === 0
      ? Promise.resolve([] as { conversationId: string }[])
      : tx
          .select({ conversationId: conversationParticipants.conversationId })
          .from(conversationParticipants)
          .where(
            and(
              inArray(conversationParticipants.conversationId, direct),
              eq(conversationParticipants.kind, 'person'),
              eq(conversationParticipants.userId, userId),
              isNull(conversationParticipants.removedAt),
            ),
          ),
  ]);
  const inRoom = new Set(joined.map((r) => r.conversationId));
  const reads = new Map<string, boolean>();
  for (const pid of new Set([...scopes.values()].flat())) {
    reads.set(pid, await can(actorFor(userId), 'project.read', projectResource(pid)));
  }
  return rooms.filter((r) => {
    const scope = scopes.get(r.id) ?? [];
    if (scope.length === 0 || !scope.every((pid) => reads.get(pid))) return false;
    return r.shape !== 'direct' || inRoom.has(r.id);
  });
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
  return assertConversationHeld(conversationId, userId, 'project.read', tx);
}

/**
 * The caller may CHANGE this conversation — rename it, delete it — or a refusal.
 */
export async function assertConversationWritable(
  conversationId: string,
  userId: string | null | undefined,
  tx: Executor = defaultDb,
): Promise<string[]> {
  return assertConversationHeld(conversationId, userId, 'project.write', tx);
}

async function assertConversationHeld(
  conversationId: string,
  userId: string | null | undefined,
  permission: ProjectPermission,
  tx: Executor = defaultDb,
): Promise<string[]> {
  if (!userId) {
    throw forbidden(
      `conversation ${conversationId} was reached with no authority named; a turn or a read names the user it runs as, and nothing here is anonymous`,
    );
  }
  const scope = await derivedScope(conversationId, tx);
  if (scope.length === 0) {
    throw forbidden(
      `conversation ${conversationId} has no handle in it, so it is about no project and nobody holds a role that reaches it`,
    );
  }
  for (const projectId of scope) {
    await requireCan(
      actorFor(userId),
      permission,
      projectResource(projectId),
      `conversation ${conversationId}`,
    );
  }
  return scope;
}
