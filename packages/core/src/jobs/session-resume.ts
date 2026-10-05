import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';

/** The context an issue's sessions may have reached and still be resumed into, in tokens. */
export const MAX_RESUME_TOKENS = 150_000;

/** ISS-580 — the peak single-request context any session of this issue reached, as `compact_boundary` counts it. */
function issueContextPeakQuery(issueId: string): SQL {
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
