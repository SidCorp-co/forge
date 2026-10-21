/**
 * The schedule fire a session runs for (design automation rev 1, step settle; REQ-16 BC-2): named on
 * the session's metadata (`scheduleRunId`, ISS-112), and taken only when that fire still exists, so a
 * session whose fire went with its schedule names none rather than a dangling id.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, scheduleRuns } from '../db/schema.js';
import { type PipelineCaller, resolvePipelineContext } from '../jobs/index.js';

async function fireOfSession(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const [row] = await db
    .select({ id: scheduleRuns.id })
    .from(agentSessions)
    .innerJoin(
      scheduleRuns,
      sql`${scheduleRuns.id}::text = ${agentSessions.metadata} ->> 'scheduleRunId'`,
    )
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row?.id ?? null;
}

// an issue a scheduled session files names that session's fire, resolved from the box credential's
// one live session on its project; a person's own credential names none
export async function fireOfCaller(caller: PipelineCaller): Promise<string | null> {
  const resolved = await resolvePipelineContext(caller);
  return resolved.ok ? fireOfSession(resolved.context.agentSessionId) : null;
}
