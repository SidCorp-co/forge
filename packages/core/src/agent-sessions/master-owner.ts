/**
 * Who owns a run session, from the master's own row. Deliberately thin: `devices/master-session.ts`
 * cycles through the pipeline-runs graph.
 */
import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';

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
