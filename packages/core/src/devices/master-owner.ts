/**
 * Who owns a session, from core's own record. Deliberately thin — reaching
 * `master-session.ts` instead cycles through the pipeline-runs graph.
 */
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { MASTER_SESSION_KIND } from '../jobs/session-kinds.js';

/** How core issues the owner edge: the box does not say who its parent is. */
export async function liveMasterSessionId(args: {
  deviceId: string;
  projectId: string;
}): Promise<string | null> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.deviceId, args.deviceId),
        eq(agentSessions.projectId, args.projectId),
        eq(agentSessions.kind, MASTER_SESSION_KIND),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * The named session, but only if it is a master of this project and box.
 *
 * The id's shape proves nothing: a uuid resolving to a chat session is as wrong
 * an answer as one resolving to no row, and a foreign key accepts both.
 */
export async function masterSessionIfOwned(args: {
  sessionId: string;
  projectId: string;
  deviceId?: string | null;
}): Promise<string | null> {
  const [row] = await db
    .select({ id: agentSessions.id, deviceId: agentSessions.deviceId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.projectId, args.projectId),
        eq(agentSessions.kind, MASTER_SESSION_KIND),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (args.deviceId != null && row.deviceId !== args.deviceId) return null;
  return row.id;
}
