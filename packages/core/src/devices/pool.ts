/**
 * The work a master agent may take, and the raw facts it needs to order it.
 *
 * The pool applies no ordering policy and no dependency gate. It answers
 * "what exists and what is true about it"; the master answers "what to run".
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export type PoolRelation = {
  kind: string;
  dependsOnKey: string | null;
  blockerStatus: string | null;
  blockerMergedAt: string | null;
  edgeValidUntil: string | null;
};

export type PoolEntry = {
  jobId: string;
  type: string;
  issueId: string | null;
  issueKey: string | null;
  title: string | null;
  description: string | null;
  priority: string | null;
  category: string | null;
  status: string | null;
  ageMinutes: number;
  attempts: number;
  relations: PoolRelation[];
  heldBy: string | null;
};

// cm:guard return the blocker's RAW status and merged_at, never a computed `satisfied` boolean. That boolean is `isBlockerSatisfied` under another name, and a fourth copy of the predicate this design exists to delete. It also destroys information the master needs: `merged_at` set with status `reopen` means landed-then-bounced, `dropped` means abandoned, and both collapse to the same `false`.
const RELATIONS = sql`
  COALESCE((
    SELECT json_agg(json_build_object(
      'kind', d.kind,
      'dependsOnKey', 'ISS-' || p.iss_seq,
      'blockerStatus', p.status,
      'blockerMergedAt', p.merged_at,
      'edgeValidUntil', d.valid_until
    ))
    FROM issue_dependencies d
    JOIN issues p ON p.id = d.from_issue_id
    WHERE d.to_issue_id = j.issue_id
  ), '[]'::json) AS relations
`;

/**
 * Claimable work for one device, newest-blocking-facts included.
 *
 * `limit` bounds the read only — taking any of it is a separate `claim`.
 */
// cm:guard `held_by IS NULL` is the ONLY exclusion beyond the job being queued under a live run. Do NOT add a dependency filter, a project cap, or an ordering by priority: each would be the kernel deciding routing again, which is the whole thing this replaces. A master that wants priority order sorts what it reads.
export async function readPool(args: {
  deviceId: string;
  projectId?: string | undefined;
  limit: number;
}): Promise<PoolEntry[]> {
  const projectFilter = args.projectId ? sql`AND j.project_id = ${args.projectId}` : sql``;

  const rows = (await db.execute(sql`
    SELECT j.id, j.type, j.issue_id, j.attempts, j.held_by,
           EXTRACT(EPOCH FROM (now() - j.queued_at)) / 60 AS age_minutes,
           i.iss_seq, i.title, i.description, i.priority, i.category, i.status,
           ${RELATIONS}
    FROM jobs j
    JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    JOIN runners r ON r.project_id = j.project_id AND r.device_id = ${args.deviceId}
    LEFT JOIN issues i ON i.id = j.issue_id
    WHERE j.status = 'queued'
      AND pr.status IN ('running', 'paused')
      AND j.held_by IS NULL
      AND (j.retry_after_at IS NULL OR j.retry_after_at <= now())
      ${projectFilter}
    GROUP BY j.id, i.iss_seq, i.title, i.description, i.priority, i.category, i.status
    ORDER BY j.queued_at ASC
    LIMIT ${args.limit}
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    jobId: String(row.id),
    type: String(row.type),
    issueId: (row.issue_id as string | null) ?? null,
    issueKey: row.iss_seq == null ? null : `ISS-${row.iss_seq}`,
    title: (row.title as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    priority: (row.priority as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    ageMinutes: Number(row.age_minutes ?? 0),
    attempts: Number(row.attempts ?? 1),
    relations: (row.relations as PoolRelation[] | null) ?? [],
    heldBy: (row.held_by as string | null) ?? null,
  }));
}
