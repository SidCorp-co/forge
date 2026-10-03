/**
 * The facts a requirement's standing reads beyond its own rows: each linked issue criterion's
 * latest verdict that is still current evidence, and the latest baseline's design pins beside the
 * revision each design is approved at now.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reopenedAtOf } from '../issues/release-evidence.js';
import type { StandingIssueCriterion } from './standing.js';

type CriterionVerdictRow = {
  issue_id: string;
  n: number;
  requirement_criterion_id: string;
  verdict: StandingIssueCriterion['verdict'];
  verdict_at: Date | string | null;
};

export async function issueCriteriaOf(
  issueIds: readonly string[],
): Promise<StandingIssueCriterion[]> {
  if (issueIds.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT c.issue_id, c.n, c.requirement_criterion_id, v.verdict
      FROM issue_criteria c
      LEFT JOIN LATERAL (
        SELECT cv.verdict, cv.created_at AS verdict_at FROM criterion_verdicts cv
         WHERE cv.criterion_id = c.id
         ORDER BY cv.created_at DESC, cv.id DESC
         LIMIT 1
      ) v ON true
     WHERE c.issue_id IN (${sql.join(
       issueIds.map((id) => sql`${id}`),
       sql`, `,
     )})
       AND c.retired_at IS NULL
       AND c.requirement_criterion_id IS NOT NULL
     ORDER BY c.issue_id, c.position, c.n`)) as unknown as CriterionVerdictRow[];
  // cm:why a verdict recorded at or before the issue's latest reopen is evidence about a build the
  // reopen rejected (`issues/release-evidence.ts:reopenedAtOf`), so coverage reads it as not judged
  const reopened = await reopenedAtOf(db, issueIds);
  return [...rows].map((r) => {
    const at = reopened.get(r.issue_id);
    const voided = at && r.verdict_at && new Date(r.verdict_at).getTime() <= at.getTime();
    return {
      issueId: r.issue_id,
      n: r.n,
      requirementCriterionId: r.requirement_criterion_id,
      verdict: voided ? null : r.verdict,
    };
  });
}

type PinRow = {
  requirement_id: string;
  flow: string;
  pinned: number | null;
  approved: number | null;
};

export async function latestPinsOf(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT p.requirement_id, w.flow, p.design_revision AS pinned, w.approved_revision AS approved
      FROM requirement_baseline_pins p
      JOIN project_workflows w ON w.id = p.workflow_id
      JOIN requirement_workflows rw
        ON rw.requirement_id = p.requirement_id AND rw.workflow_id = p.workflow_id
     WHERE p.requirement_id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})
       AND (p.revision, p.baseline_seq) = (
             SELECT b.revision, b.seq FROM requirement_baselines b
              WHERE b.requirement_id = p.requirement_id
              ORDER BY b.revision DESC, b.seq DESC LIMIT 1)`)) as unknown as PinRow[];
  return [...rows].map((r) => ({
    requirementId: r.requirement_id,
    flow: r.flow,
    pinned: r.pinned,
    approved: r.approved,
  }));
}
