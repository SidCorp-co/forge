/**
 * ISS-198 — minimal recovery-stats helper.
 *
 * Counts an issue's recent failures by classification. Legacy helper from the
 * manual-hold era (ISS-198); retained for any external caller but no longer
 * consumed by the failure path after ISS-393 removed the hold model.
 *
 * This is intentionally a thin query over `jobs.failure_kind` — ISS-197
 * lands a richer recovery subsystem that supersedes this helper. We keep the
 * shape (`{ transientFailures, permissionFailures }`) compatible so callers
 * don't need to change when that lands.
 *
 * Window: the last 24h of failures for the issue. A longer window dilutes
 * the "is this still transient?" signal; a shorter one undercounts slow
 * provider degradation that recovers across multiple retries.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface RecoveryStats {
  transientFailures: number;
  permissionFailures: number;
}

const ZERO: RecoveryStats = { transientFailures: 0, permissionFailures: 0 };

export async function loadRecoveryStats(issueId: string | null): Promise<RecoveryStats> {
  if (!issueId) return ZERO;
  const rows = await db.execute<{ transient: string; permanent: string }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE failure_kind = 'transient')::text AS transient,
      COUNT(*) FILTER (WHERE failure_kind = 'permanent')::text AS permanent
    FROM jobs
    WHERE issue_id = ${issueId}
      AND status = 'failed'
      AND finished_at > now() - interval '24 hours'
  `);
  const row = rows[0];
  if (!row) return ZERO;
  return {
    transientFailures: Number(row.transient ?? '0') || 0,
    permissionFailures: Number(row.permanent ?? '0') || 0,
  };
}
