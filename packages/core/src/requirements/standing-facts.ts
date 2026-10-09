/**
 * The facts a requirement's standing reads beyond its own rows: each linked issue criterion's
 * latest verdict that is still current evidence with the commit it was judged at, and the latest baseline's design and contract pins
 * beside the revision or version each is approved at now.
 */

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { reopenedAtOf } from '../issues/index.js';
import { requirementDependents } from './dependents.js';
import type { LiveBuildHolds, StandingIssueCriterion } from './standing.js';

type CriterionVerdictRow = {
  issue_id: string;
  n: number;
  requirement_criterion_id: string;
  verdict: StandingIssueCriterion['verdict'];
  verdict_at: Date | string | null;
  commit_sha: string | null;
};

export async function issueCriteriaOf(
  issueIds: readonly string[],
  ex: Pick<Tx, 'execute'> = db,
): Promise<StandingIssueCriterion[]> {
  if (issueIds.length === 0) return [];
  const rows = (await ex.execute(sql`
    SELECT c.issue_id, c.n, c.requirement_criterion_id, v.verdict, v.verdict_at, v.commit_sha
      FROM issue_criteria c
      LEFT JOIN LATERAL (
        SELECT cv.verdict, cv.created_at AS verdict_at, cv.commit_sha FROM criterion_verdicts cv
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
  // A verdict recorded at or before the issue's latest reopen is evidence about a build the
  // reopen rejected (`issues/release-evidence.ts:reopenedAtOf`), so coverage reads it as not judged
  const reopened = await reopenedAtOf(ex, issueIds);
  return [...rows].map((r) => {
    const at = reopened.get(r.issue_id);
    const voided = at && r.verdict_at && new Date(r.verdict_at).getTime() <= at.getTime();
    return {
      issueId: r.issue_id,
      n: r.n,
      requirementCriterionId: r.requirement_criterion_id,
      verdict: voided ? null : r.verdict,
      verdictAt: voided || !r.verdict_at ? null : new Date(r.verdict_at),
      commit: voided ? null : r.commit_sha,
    };
  });
}

/** What the live build holds of the commits `rows`' judgements were made at; null where none names one or it cannot be read. */
export async function liveBuildOf(
  projectId: string,
  rows: readonly StandingIssueCriterion[],
): Promise<LiveBuildHolds | null> {
  const commits = rows.flatMap((r) =>
    r.commit && r.verdict !== null && r.verdict !== 'skipped' ? [r.commit] : [],
  );
  if (commits.length === 0) return null;
  return requirementDependents().liveBuildHolds(projectId, commits);
}

type PinRow = {
  requirement_id: string;
  flow: string;
  title: string | null;
  pinned: number | null;
  approved: number | null;
};

export async function latestPinsOf(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT rw.requirement_id, w.flow, w.document->>'title' AS title, p.design_revision AS pinned, w.approved_revision AS approved
      FROM requirement_workflows rw
      JOIN project_workflows w ON w.id = rw.workflow_id
      JOIN LATERAL (
             SELECT b.revision, b.seq FROM requirement_baselines b
              WHERE b.requirement_id = rw.requirement_id
              ORDER BY b.revision DESC, b.seq DESC LIMIT 1) lb ON true
      LEFT JOIN requirement_baseline_pins p
        ON p.requirement_id = rw.requirement_id AND p.workflow_id = rw.workflow_id
       AND p.revision = lb.revision AND p.baseline_seq = lb.seq
     WHERE rw.requirement_id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})`)) as unknown as PinRow[];
  return [...rows].map((r) => ({
    requirementId: r.requirement_id,
    flow: r.flow,
    title: r.title,
    pinned: r.pinned,
    approved: r.approved,
  }));
}

type ContractPinRow = {
  requirement_id: string;
  provider_project_id: string;
  contract_slug: string;
  contract_version: string;
};

/** The contract pins of each requirement's latest baseline. */
export async function latestContractPinsOf(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT p.requirement_id, p.provider_project_id, p.contract_slug, p.contract_version
      FROM requirement_baseline_pins p
     WHERE p.requirement_id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})
       AND p.contract_slug IS NOT NULL
       AND (p.revision, p.baseline_seq) = (
             SELECT b.revision, b.seq FROM requirement_baselines b
              WHERE b.requirement_id = p.requirement_id
              ORDER BY b.revision DESC, b.seq DESC LIMIT 1)`)) as unknown as ContractPinRow[];
  return [...rows].map((r) => ({
    requirementId: r.requirement_id,
    providerProjectId: r.provider_project_id,
    contractSlug: r.contract_slug,
    contractVersion: r.contract_version,
  }));
}

/** When each closed issue last moved to closed, from its kernel transitions. */
export async function closedAtOf(issueIds: readonly string[]): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT entity_id, max(created_at) AS at
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND to_status = 'closed'
       AND entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     GROUP BY entity_id`)) as unknown as Array<{ entity_id: string; at: Date | string }>;
  return new Map([...rows].map((r) => [r.entity_id, new Date(r.at)]));
}

/** Each requirement's linked designs that hold no approved revision, which an agree refuses. */
export async function unapprovedDesignsOf(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT rw.requirement_id, w.flow, w.document->>'title' AS title, w.design_status
      FROM requirement_workflows rw
      JOIN project_workflows w ON w.id = rw.workflow_id
     WHERE w.approved_revision IS NULL
       AND rw.requirement_id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})
     ORDER BY w.flow`)) as unknown as {
    requirement_id: string;
    flow: string;
    title: string | null;
    design_status: string | null;
  }[];
  return [...rows].map((r) => ({
    requirementId: r.requirement_id,
    flow: r.flow,
    title: r.title ?? r.flow,
    designStatus: r.design_status,
  }));
}
