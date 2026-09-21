import { eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';

const DEFAULT_MAX_RESUME_TOKENS = 150_000;

export interface ResumeBounds {
  maxResumeTokens: number;
}

export async function loadResumeBounds(
  projectId: string,
  cachedAgentConfig?: Record<string, unknown>,
): Promise<ResumeBounds> {
  try {
    let ac: Record<string, unknown>;
    if (cachedAgentConfig !== undefined) {
      ac = cachedAgentConfig;
    } else {
      const [row] = await db
        .select({ agentConfig: projects.agentConfig })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      ac = (row?.agentConfig ?? {}) as Record<string, unknown>;
    }
    const pc = (ac.pipelineConfig ?? {}) as Record<string, unknown>;
    const maxTokens =
      typeof pc.maxResumeTokens === 'number' && Number.isFinite(pc.maxResumeTokens)
        ? pc.maxResumeTokens
        : DEFAULT_MAX_RESUME_TOKENS;
    return { maxResumeTokens: maxTokens };
  } catch (err) {
    logger.warn({ err, projectId }, 'session-resume: failed to load resume bounds, using defaults');
    return { maxResumeTokens: DEFAULT_MAX_RESUME_TOKENS };
  }
}

/**
 * ISS-580 — the peak single-request context any session of this issue has
 * reached (`MAX(input_tokens + cache_read_tokens)`), which mirrors the
 * `compact_boundary` pre-token value.
 *
 * Exported so the index test can EXPLAIN the query `estimateIssueContextTokens`
 * actually runs, rather than a copy of it that cannot observe a regression here.
 */
export function issueContextPeakQuery(issueId: string): SQL {
  return sql`
    SELECT MAX(ur.input_tokens + ur.cache_read_tokens) AS peak
    FROM agent_sessions AS s
    JOIN usage_records AS ur
      ON ur.session_id = s.id::text
    WHERE s.metadata->>'issueId' = ${issueId}`;
}

/** The peak above, or 0 on no rows or a DB error, so a broken estimate never blocks a dispatch. */
export async function estimateIssueContextTokens(issueId: string): Promise<number> {
  try {
    const rows = await db.execute<{ peak: string | null }>(issueContextPeakQuery(issueId));
    const peak = rows[0]?.peak;
    if (peak === null || peak === undefined) return 0;
    const n = Number(peak);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    logger.warn({ err, issueId }, 'session-resume: context estimate failed, defaulting to 0');
    return 0;
  }
}
