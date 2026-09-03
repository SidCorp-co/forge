// Resume bounds, and where they come from.
//
// The (issue, sessionGroup) lookup this module was built around left with
// `pipelineConfig.sessionGroups` (ISS-897) — one dispatching status has no
// group of stages to share a session across. What survives is the per-project
// bound a retry-resume is still judged against.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
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
 *
 * Pass `cachedAgentConfig` (already fetched by the caller) to skip the DB
 * round-trip — the dispatcher fetches it on the non-forced dispatch path.
 */
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
    const maxCycles =
      typeof pc.maxResumeReopenCycles === 'number' && Number.isFinite(pc.maxResumeReopenCycles)
        ? pc.maxResumeReopenCycles
        : DEFAULT_MAX_RESUME_REOPEN_CYCLES;
    return { maxResumeTokens: maxTokens, maxResumeReopenCycles: maxCycles };
  } catch (err) {
    logger.warn({ err, projectId }, 'session-resume: failed to load resume bounds, using defaults');
    return {
      maxResumeTokens: DEFAULT_MAX_RESUME_TOKENS,
      maxResumeReopenCycles: DEFAULT_MAX_RESUME_REOPEN_CYCLES,
    };
  }
}

/**
 * ISS-580 — the peak single-request context any session of this issue has
 * reached (`MAX(input_tokens + cache_read_tokens)`), which mirrors the
 * `compact_boundary` pre-token value. Fail-safe: 0 on no rows or DB error, so
 * a broken estimate never blocks a dispatch.
 */
// cm:guard scoped to the ISSUE since ISS-897 removed session groups, and that is deliberately BROADER than the resume it guards: a retry resumes one parent attempt, but every session of an issue shares the transcript that attempt would reload, so the widest peak is the honest bound. Narrowing it to one session id would let a chain of small attempts resume past a peak that has already forced a compaction.
export async function estimateIssueContextTokens(issueId: string): Promise<number> {
  try {
    const rows = await db.execute<{ peak: string | null }>(sql`
      SELECT MAX(ur.input_tokens + ur.cache_read_tokens) AS peak
      FROM agent_sessions AS s
      JOIN usage_records AS ur
        ON ur.session_id ~ '^[0-9a-fA-F-]{36}$'
       AND ur.session_id::uuid = s.id
      WHERE s.metadata->>'issueId' = ${issueId}
    `);
    const peak = rows[0]?.peak;
    if (peak === null || peak === undefined) return 0;
    const n = Number(peak);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    logger.warn({ err, issueId }, 'session-resume: context estimate failed, defaulting to 0');
    return 0;
  }
}
