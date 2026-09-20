/**
 * Who owns a session, resolved from core's own record.
 *
 * Deliberately thin: the db client, the schema and the kind vocabulary, and
 * nothing else. `agent-session-link.ts` and `session-descent.ts` both resolve
 * an owner while the transition chokepoint is importing them, and reaching
 * `master-session.ts` for it drags the whole pipeline-runs graph through a
 * module cycle — which showed up as the descent throwing on its own module
 * constant and being swallowed by its error path (ISS-1136).
 */

import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { MASTER_SESSION_KIND } from '../jobs/session-kinds.js';

/**
 * The live master session for one (device, project), or `null`.
 *
 * This is how core issues the owner edge for a run session: the box does not
 * get to say who its parent is, because core already registered a master for
 * that pair and `agent_sessions_one_live_master_uq` makes the answer single.
 */
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
 * A caller hands this an id it read off somewhere else — `jobs.held_by`, a
 * box's ledger frame — and gets back either a parent core can stand behind or
 * `null`. The id's shape proves nothing: a uuid resolving to a chat session is
 * as wrong an answer as one resolving to no row at all, and a foreign key would
 * accept both.
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
