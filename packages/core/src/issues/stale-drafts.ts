/**
 * The draft issues nobody touched for a week (REQ-41 BC-12; Issue lifecycle `draft`), read for the
 * merge-or-drop sweep the requirements domain runs (`requirements/stale-drafts.ts`), which reads the
 * product record for its recommendation and asks the question: the issues kernel imports no domain.
 * A draft behind a live blocker waits on that blocker, and one with an open question already waits
 * on its answer, so neither is stale; nor is one asked about within the spell.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { blockedByUnsettledSql } from './blocked-by.js';

export interface StaleDraftIssue {
  id: string;
  projectId: string;
  issSeq: number;
  title: string;
  requirementId: string | null;
  touchedAt: Date;
  /** A live issue of the project with the same title, the one a merge would fold this into. */
  twinId: string | null;
}

/**
 * Every draft issue last touched at or before `cutoff`, with no live blocker, no open question, and
 * no question carrying `askedMark` (a jsonb array of the merge-or-drop options) written after `cutoff`.
 */
export async function staleDraftIssues(
  cutoff: Date,
  askedMark: string,
): Promise<StaleDraftIssue[]> {
  const rows = rowsOf<{
    id: string;
    project_id: string;
    iss_seq: number;
    title: string;
    requirement_id: string | null;
    updated_at: Date | string;
    twin_id: string | null;
  }>(
    await db.execute(sql`
      SELECT i.id, i.project_id, i.iss_seq, i.title, i.requirement_id, i.updated_at,
             (SELECT t.id FROM issues t
               WHERE t.project_id = i.project_id AND t.id <> i.id
                 AND t.status NOT IN ('dropped', 'closed')
                 AND lower(btrim(t.title)) = lower(btrim(i.title))
               ORDER BY (t.status = 'draft'), t.iss_seq LIMIT 1) AS twin_id
        FROM issues i
       WHERE i.status = 'draft'
         AND i.updated_at <= ${cutoff.toISOString()}
         AND NOT ${blockedByUnsettledSql({ issueId: sql`i.id`, projectId: sql`i.project_id` })}
         AND NOT EXISTS (
               SELECT 1 FROM agent_questions q
                WHERE q.issue_id = i.id
                  AND (q.status = 'open'
                       OR (q.steps -> 0 -> 'options' @> ${askedMark}::jsonb
                           AND q.updated_at > ${cutoff.toISOString()})))
       ORDER BY i.project_id, i.iss_seq`),
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    issSeq: Number(r.iss_seq),
    title: r.title,
    requirementId: r.requirement_id,
    touchedAt: new Date(r.updated_at),
    twinId: r.twin_id,
  }));
}
