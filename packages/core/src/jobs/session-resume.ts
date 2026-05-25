/**
 * PR-5 — resume the prior Claude CLI session of a pipeline session-group.
 *
 * A session group is a named set of stages declared in
 * `pipelineConfig.sessionGroups`. The first stage dispatched in a group
 * creates a fresh CLI session; subsequent stages of the SAME group on the
 * SAME issue resume it via `--resume <claudeSessionId>`.
 *
 * Lookup strategy:
 *  - Filter by metadata.issueId + metadata.sessionGroup + claudeSessionId IS NOT NULL
 *  - Prefer status='completed' (clean prior runs); fall back to 'failed' is
 *    intentionally NOT allowed — a failed session may have a corrupted CLI
 *    file. Operator can re-trigger if they want to inherit a failed session.
 *  - Order by createdAt DESC, take the most recent.
 *
 * Returns the prior session's claudeSessionId + the deviceId that hosts
 * its session file, so the dispatcher can pin selection to the same host.
 *
 * ISS-226 — invariant: by the time the dispatcher calls
 * `findPriorSessionInGroup`, every prior `(issueId, sessionGroup)` session
 * is guaranteed terminal. The barrier lives in `handleDispatch` and is
 * implemented by `dispatch-gates.ts#hasNonTerminalPriorSession`. Do NOT
 * relax the strict `status='completed'` filter below to widen the lookup —
 * the issue body of ISS-226 forbids it (a still-`running` row may not have
 * its final claudeSessionId flushed; a row that later fails would poison
 * the resume). Fix lifecycle ordering, not the filter.
 */

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { logger } from '../logger.js';

export interface PriorSession {
  claudeSessionId: string;
  deviceId: string | null;
}

export async function findPriorSessionInGroup(args: {
  issueId: string;
  sessionGroup: string;
}): Promise<PriorSession | null> {
  try {
    const [row] = await db
      .select({
        claudeSessionId: agentSessions.claudeSessionId,
        deviceId: agentSessions.deviceId,
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.status, 'completed'),
          isNotNull(agentSessions.claudeSessionId),
          sql`${agentSessions.metadata}->>'issueId' = ${args.issueId}`,
          sql`${agentSessions.metadata}->>'sessionGroup' = ${args.sessionGroup}`,
        ),
      )
      .orderBy(desc(agentSessions.createdAt))
      .limit(1);
    if (!row?.claudeSessionId) return null;
    return { claudeSessionId: row.claudeSessionId, deviceId: row.deviceId };
  } catch (err) {
    // Surface DB hiccups so operators don't see "no prior session" as silent
    // resume regressions. Caller treats null as "dispatch fresh" — the
    // failure is non-fatal, but invisible degradation is the worst kind.
    logger.warn(
      { err, issueId: args.issueId, sessionGroup: args.sessionGroup },
      'session-resume: prior-session lookup failed, falling back to fresh dispatch',
    );
    return null;
  }
}
