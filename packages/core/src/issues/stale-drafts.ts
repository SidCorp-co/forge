/**
 * The draft issues nobody touched for a week (REQ-41 BC-12; Issue lifecycle `draft`), read for the
 * merge-or-drop sweep the requirements domain runs (`requirements/stale-drafts.ts`), which reads the
 * product record for its recommendation and asks the question: the issues kernel imports no domain.
 * A draft behind a live blocker waits on that blocker, and one with an open question already waits
 * on its answer, so neither is stale; nor is one asked about within the spell.
 */

import { STALE_DRAFT_ASKED_MARK, staleDraftRefusedOf } from '@forge/contracts/stale-drafts';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { blockedByUnsettledSql } from './blocked-by.js';
import { DISPATCH_GATING_KIND } from './dependency-effects.js';
import type { IssueStandingInput } from './standing.js';

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

/**
 * The issues a draft holds through a live `blocks` edge, by key: a merge moves the draft's text into
 * another issue, not its edges, so a draft that holds any is not merged by rule.
 */
export async function draftMergeHolds(issueId: string): Promise<string[]> {
  const rows = rowsOf<{ iss_seq: number; issue_prefix: string | null }>(
    await db.execute(sql`
      SELECT t.iss_seq, p.issue_prefix
        FROM issue_dependencies d
        JOIN issues t ON t.id = d.to_issue_id
        JOIN projects p ON p.id = t.project_id
       WHERE d.from_issue_id = ${issueId} AND d.kind = ${DISPATCH_GATING_KIND}
         AND (d.valid_until IS NULL OR d.valid_until > now())
         AND t.status NOT IN ('dropped', 'closed')
       ORDER BY t.iss_seq`),
  );
  return rows.map((r) => formatIssueRef(r.issue_prefix, Number(r.iss_seq)));
}

/** The newest merge-or-drop question on a draft, as the standing read selects it. */
export interface StaleDraftQuestionRaw {
  status: string;
  days: number;
  resume: { kind?: string; code?: string; detail?: string } | null;
}

/**
 * The newest merge-or-drop question Forge's sweep asked on draft `i` (REQ-41 BC-12), by the mark its
 * options carry, with the days the draft had been untouched when it was asked.
 */
export const staleDraftQuestionSql = (i: SQL) => sql`(
  SELECT jsonb_build_object('status', q.status, 'resume', q.steps -> -1 -> 'resume',
           'days', GREATEST(0, floor(extract(epoch FROM q.created_at - ${i}.updated_at) / 86400))::int)
    FROM agent_questions q
   WHERE q.issue_id = ${i}.id AND q.status IN ('open', 'answered')
     AND q.steps -> 0 -> 'options' @> ${STALE_DRAFT_ASKED_MARK}::jsonb
   ORDER BY q.created_at DESC, q.id DESC LIMIT 1)`;

/** The standing's fact from that question: still open, or answered with an act core refused. */
export function staleDraftOf(
  raw: StaleDraftQuestionRaw | null,
): NonNullable<IssueStandingInput['staleDraft']> | null {
  if (!raw) return null;
  const refused = staleDraftRefusedOf(raw.status, raw.resume);
  return { open: raw.status === 'open', days: Number(raw.days), refused };
}
