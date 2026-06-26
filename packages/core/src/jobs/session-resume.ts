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
import { agentSessions, projects } from '../db/schema.js';
import { logger } from '../logger.js';

const DEFAULT_MAX_RESUME_TOKENS = 150_000;
const DEFAULT_MAX_RESUME_REOPEN_CYCLES = 3;

export interface ResumeBounds {
  maxResumeTokens: number;
  maxResumeReopenCycles: number;
}

/**
 * ISS-580 — load the project's session-resume bounds from pipelineConfig.
 * Defaults to 150k tokens / 3 reopen cycles when absent or on DB error.
 * Mirrors the loadOnResumeFailPolicy pattern from handle-resume-failed.ts.
 */
export async function loadResumeBounds(projectId: string): Promise<ResumeBounds> {
  try {
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const ac = (row?.agentConfig ?? {}) as Record<string, unknown>;
    const pc = (ac.pipelineConfig ?? {}) as Record<string, unknown>;
    const maxTokens =
      typeof pc.maxResumeTokens === 'number' && Number.isFinite(pc.maxResumeTokens)
        ? pc.maxResumeTokens
        : DEFAULT_MAX_RESUME_TOKENS;
    const maxCycles =
      typeof pc.maxResumeReopenCycles === 'number' && Number.isFinite(pc.maxResumeReopenCycles)
        ? pc.maxResumeReopenCycles
        : DEFAULT_MAX_RESUME_REOPEN_CYCLES;
    return { maxResumeTokens: maxTokens, maxResumeReopenCycles: maxCycles };
  } catch (err) {
    logger.warn({ err, projectId }, 'session-resume: failed to load resume bounds, using defaults');
    return { maxResumeTokens: DEFAULT_MAX_RESUME_TOKENS, maxResumeReopenCycles: DEFAULT_MAX_RESUME_REOPEN_CYCLES };
  }
}

/**
 * ISS-580 — estimate the peak single-request context for all sessions in a
 * (issueId, sessionGroup) group by querying MAX(input_tokens+cache_read_tokens)
 * from usage_records joined via agent_sessions. This mirrors the compact_boundary
 * pre_tokens value — the largest single turn seen for this group.
 *
 * Returns 0 on no rows or DB error (fail-safe: never blocks dispatch).
 */
export async function estimateGroupContextTokens(args: {
  issueId: string;
  sessionGroup: string;
}): Promise<number> {
  try {
    const rows = await db.execute<{ peak: string | null }>(sql`
      SELECT MAX(ur.input_tokens + ur.cache_read_tokens) AS peak
      FROM agent_sessions AS s
      JOIN usage_records AS ur ON ur.session_id = s.id
      WHERE s.metadata->>'issueId' = ${args.issueId}
        AND s.metadata->>'sessionGroup' = ${args.sessionGroup}
    `);
    const peak = rows[0]?.peak;
    if (peak === null || peak === undefined) return 0;
    const n = Number(peak);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    logger.warn(
      { err, issueId: args.issueId, sessionGroup: args.sessionGroup },
      'session-resume: estimateGroupContextTokens failed, defaulting to 0',
    );
    return 0;
  }
}

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
