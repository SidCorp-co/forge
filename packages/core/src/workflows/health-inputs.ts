/**
 * The records the workflow health read model reads for one design (workflow-step-health `in-*`),
 * each turned into the facts `health-rules.ts:deriveHealth` decides on. Stored rows that no longer
 * parse are refused by name, never guessed at.
 */

import { requirementKey } from '@forge/contracts/requirements';
import { VERDICT_VALUES } from '@forge/contracts/verdict-identity';
import { designChangePayloadSchema, nodeDecisionSchema } from '@forge/contracts/workflow-health';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { type HealthViewer, latestRunsOf } from './health-ports.js';
import type { HealthFacts, PlannedTarget } from './health-rules.js';
import { observationDocumentSchema } from './observation-schema.js';

export const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
export const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
const ids = (list: readonly string[]) =>
  sql.join(
    list.map((v) => sql`${v}`),
    sql`, `,
  );

function traceOf(r: {
  step_id: string | null;
  edge_from: string | null;
  edge_to: string | null;
  edge_label: string | null;
}): PlannedTarget | null {
  if (r.step_id) return { kind: 'step', step: r.step_id };
  if (r.edge_from && r.edge_to) {
    return { kind: 'edge', from: r.edge_from, to: r.edge_to, label: r.edge_label };
  }
  return null;
}

const present = <T>(x: T | null): x is T => x !== null;

export async function criteriaOf(workflowId: string): Promise<HealthFacts['criteria']> {
  const rows = rowsOf<{
    req_seq: number;
    code: string;
    since_revision: number;
    accepted_at: string | null;
    step_id: string | null;
    edge_from: string | null;
    edge_to: string | null;
    edge_label: string | null;
    proof: string | null;
  }>(
    await db.execute(sql`
      SELECT r.req_seq, s.code, c.since_revision, rr.decided_at AS accepted_at,
             s.step_id, s.edge_from, s.edge_to, s.edge_label,
             (SELECT v.verdict FROM issue_criteria ic
                JOIN criterion_verdicts v ON v.criterion_id = ic.id
               WHERE ic.requirement_criterion_id = c.id AND ic.retired_at IS NULL
               ORDER BY v.created_at DESC LIMIT 1) AS proof
        FROM requirement_criterion_steps s
        JOIN requirement_workflows l ON l.requirement_id = s.requirement_id AND l.workflow_id = s.workflow_id
        JOIN requirements r ON r.id = s.requirement_id
        JOIN requirement_criteria c ON c.requirement_id = s.requirement_id AND c.code = s.code
             AND c.retired_revision IS NULL
        LEFT JOIN requirement_revisions rr ON rr.requirement_id = c.requirement_id
             AND rr.revision = c.since_revision
       WHERE s.workflow_id = ${workflowId}
       ORDER BY r.req_seq, s.code`),
  );
  const byCode = new Map<string, HealthFacts['criteria'][number]>();
  for (const r of rows) {
    const key = `${r.req_seq}:${r.code}`;
    const entry = byCode.get(key) ?? {
      requirementKey: requirementKey(Number(r.req_seq)),
      code: r.code,
      sinceRevision: Number(r.since_revision),
      sinceAcceptedAt: date(r.accepted_at),
      targets: [],
      proof: VERDICT_VALUES.find((v) => v === r.proof) ?? null,
    };
    const t = traceOf(r);
    if (t) entry.targets.push(t);
    byCode.set(key, entry);
  }
  return [...byCode.values()];
}

export async function contractPinsOf(workflowId: string): Promise<HealthFacts['contractPins']> {
  const rows = rowsOf<{
    provider: string;
    contract_slug: string;
    contract_version: string;
    breaking_version: string | null;
    breaking_at: string | null;
  }>(
    await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (b.requirement_id) b.requirement_id, b.revision, b.seq
          FROM requirement_baselines b
          JOIN requirement_workflows l ON l.requirement_id = b.requirement_id AND l.workflow_id = ${workflowId}
         ORDER BY b.requirement_id, b.revision DESC, b.seq DESC)
      SELECT pr.slug AS provider, p.contract_slug, p.contract_version,
             nb.version AS breaking_version, nb.recorded_at AS breaking_at
        FROM requirement_baseline_pins p
        JOIN latest ON latest.requirement_id = p.requirement_id AND latest.revision = p.revision
             AND latest.seq = p.baseline_seq
        JOIN projects pr ON pr.id = p.provider_project_id
        JOIN contract_versions pv ON pv.provider_project_id = p.provider_project_id
             AND pv.contract_slug = p.contract_slug AND pv.version = p.contract_version
        LEFT JOIN LATERAL (
          SELECT v.version, v.recorded_at FROM contract_versions v
           WHERE v.provider_project_id = p.provider_project_id AND v.contract_slug = p.contract_slug
             AND v.classification = 'breaking' AND v.recorded_at > pv.recorded_at
           ORDER BY v.recorded_at DESC LIMIT 1) nb ON true
       WHERE p.contract_slug IS NOT NULL`),
  );
  return rows.map((r) => ({
    provider: r.provider,
    slug: r.contract_slug,
    pinnedVersion: r.contract_version,
    newestBreaking:
      r.breaking_version && r.breaking_at
        ? { version: r.breaking_version, recordedAt: new Date(r.breaking_at) }
        : null,
  }));
}

export async function suggestionsOf(workflowId: string): Promise<HealthFacts['suggestions']> {
  const rows = rowsOf<{
    id: string;
    status: string;
    payload: unknown;
    created_at: string;
    decided_at: string | null;
  }>(
    await db.execute(sql`
      SELECT id, status, payload, created_at, decided_at FROM suggestions
       WHERE workflow_id = ${workflowId} AND kind = 'design_change' AND status IN ('proposed', 'accepted')
       ORDER BY created_at`),
  );
  return rows.flatMap((r) => {
    if (r.payload === null) return [];
    const parsed = designChangePayloadSchema.safeParse(r.payload);
    if (!parsed.success) {
      throw new Error(
        `suggestion ${r.id} holds a design_change payload that no longer parses (${parsed.error.issues[0]?.message ?? 'unknown'}); the stored row is repaired, never guessed at.`,
      );
    }
    const p = parsed.data;
    const targets: PlannedTarget[] = [
      ...(p.steps ?? []).map((step) => ({ kind: 'step' as const, step })),
      ...(p.edges ?? []).map((e) => ({
        kind: 'edge' as const,
        from: e.from,
        to: e.to,
        label: e.label ?? null,
      })),
    ];
    return [
      {
        id: r.id,
        status: r.status,
        change: p.change,
        targets,
        reason: p.reason,
        createdAt: new Date(r.created_at),
        decidedAt: date(r.decided_at),
      },
    ];
  });
}

export async function buildsOf(
  viewer: HealthViewer,
  projectId: string,
  workflowId: string,
): Promise<HealthFacts['builds']> {
  const builds = rowsOf<{
    issue_id: string;
    iss_seq: number;
    status: string;
    reopen_count: number;
    updated_at: string;
    merged_at: string | null;
    linked_at: string;
    step_ids: string[] | null;
    observed_step_ids: string[] | null;
    release_version: string | null;
    release_released_at: string | null;
  }>(
    await db.execute(sql`
      SELECT i.id AS issue_id, i.iss_seq, i.status, i.reopen_count, i.updated_at, i.merged_at,
             b.linked_at, b.step_ids, b.observed_step_ids, r.release_version, r.release_released_at
        FROM workflow_builds b JOIN issues i ON i.id = b.issue_id
        LEFT JOIN pipeline_runs r ON r.id = i.release_batch_run_id AND r.release_version IS NOT NULL
       WHERE b.workflow_id = ${workflowId} AND i.archived_at IS NULL`),
  );
  if (builds.length === 0) return [];
  const issueIds = builds.map((b) => b.issue_id);
  const [traces, verdicts, runs] = await Promise.all([
    db.execute(sql`
      SELECT ic.issue_id, s.step_id, s.edge_from, s.edge_to, s.edge_label
        FROM issue_criteria ic
        JOIN requirement_criteria c ON c.id = ic.requirement_criterion_id
        JOIN requirement_criterion_steps s ON s.requirement_id = c.requirement_id AND s.code = c.code
             AND s.workflow_id = ${workflowId}
       WHERE ic.issue_id::text IN (${ids(issueIds)}) AND ic.retired_at IS NULL`),
    db.execute(sql`
      SELECT DISTINCT ON (v.criterion_id) ic.issue_id, ic.n, v.verdict, v.reason,
             v.design_workflow_id, v.design_revision, v.created_at
        FROM issue_criteria ic JOIN criterion_verdicts v ON v.criterion_id = ic.id
       WHERE ic.issue_id::text IN (${ids(issueIds)}) AND ic.retired_at IS NULL
       ORDER BY v.criterion_id, v.created_at DESC`),
    latestRunsOf(viewer, projectId, issueIds),
  ]);
  const traceRows = rowsOf<{
    issue_id: string;
    step_id: string | null;
    edge_from: string | null;
    edge_to: string | null;
    edge_label: string | null;
  }>(traces);
  const verdictRows = rowsOf<{
    issue_id: string;
    n: number;
    verdict: string;
    reason: string | null;
    design_workflow_id: string | null;
    design_revision: number | null;
    created_at: string;
  }>(verdicts);
  const runOf = new Map(runs.map((r) => [r.issueId, r.run]));
  return builds.map((b) => {
    const traced = traceRows
      .filter((t) => t.issue_id === b.issue_id)
      .map(traceOf)
      .filter(present);
    const named = (b.step_ids ?? []).map((step): PlannedTarget => ({ kind: 'step', step }));
    const seen = new Set<string>();
    const targets = [...traced, ...named].filter((t) => {
      const k = t.kind === 'step' ? t.step : `${t.from}>${t.to}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const mine = verdictRows.filter((v) => v.issue_id === b.issue_id);
    const run = runOf.get(b.issue_id);
    const closed = b.status === 'closed';
    return {
      issueKey: canonicalIssueKey(Number(b.iss_seq)),
      status: b.status,
      reopenCount: Number(b.reopen_count),
      updatedAt: new Date(b.updated_at),
      linkedAt: new Date(b.linked_at),
      closedAt: closed ? new Date(b.merged_at ?? b.updated_at) : null,
      targets,
      observedSteps: b.observed_step_ids ?? [],
      release: b.release_version
        ? { version: b.release_version, releasedAt: date(b.release_released_at) }
        : null,
      failing: mine
        .filter((v) => v.verdict === 'fail')
        .map((v) => ({ n: Number(v.n), reason: v.reason, at: new Date(v.created_at) })),
      judgedAgainst: mine
        .filter((v) => v.design_workflow_id === workflowId && v.design_revision !== null)
        .map((v) => ({ revision: Number(v.design_revision), at: new Date(v.created_at) })),
      run: run ? { id: run.id, state: run.state, since: run.since, rule: run.rule } : null,
    };
  });
}

export async function observationOf(workflowId: string): Promise<HealthFacts['observation']> {
  const [row] = rowsOf<{
    id: string;
    at_sha: string;
    revision: number;
    created_at: string;
    written_by: string;
    written_by_agency: 'human' | 'agent';
    document: unknown;
  }>(
    await db.execute(sql`
      SELECT id, at_sha, revision, created_at, written_by, written_by_agency, document
        FROM project_workflow_observations WHERE workflow_id = ${workflowId}
       ORDER BY created_at DESC LIMIT 1`),
  );
  if (!row) return null;
  const parsed = observationDocumentSchema.safeParse(row.document);
  if (!parsed.success) {
    throw new Error(
      `observation ${row.id} no longer parses as an observation document (${parsed.error.issues[0]?.message ?? 'unknown'}); the stored row is repaired, never guessed at.`,
    );
  }
  return {
    id: row.id,
    atSha: row.at_sha,
    revision: Number(row.revision),
    createdAt: new Date(row.created_at),
    writtenBy: row.written_by,
    writtenByAgency: row.written_by_agency,
    document: parsed.data,
  };
}

export async function decisionsOf(workflowId: string): Promise<HealthFacts['decisions']> {
  const rows = rowsOf<{
    id: string;
    decision: { reason?: string; node?: unknown };
    author_id: string | null;
    created_at: string;
  }>(
    await db.execute(sql`
      SELECT id, decision, author_id, created_at FROM comments
       WHERE workflow_id = ${workflowId} AND intent = 'decision' AND decision ? 'node'
       ORDER BY created_at DESC, id DESC`),
  );
  const names = await peopleOf(rows.map((r) => r.author_id));
  return rows.map((r) => {
    const node = nodeDecisionSchema.safeParse(r.decision.node);
    if (!node.success) {
      throw new Error(
        `decision comment ${r.id} holds a node that no longer parses (${node.error.issues[0]?.message ?? 'unknown'}); the stored row is repaired, never guessed at.`,
      );
    }
    return {
      commentId: r.id,
      node: node.data,
      reason: r.decision.reason ?? '',
      by: r.author_id,
      byName: r.author_id ? (names.get(r.author_id)?.name ?? null) : null,
      at: new Date(r.created_at),
    };
  });
}

export async function designRowsOf(workflowId: string) {
  return rowsOf<{
    revision: number;
    document: unknown;
    decision: string | null;
    decided_at: string | null;
    proposed_at: string;
  }>(
    await db.execute(sql`
      SELECT revision, document, decision, decided_at, proposed_at FROM project_workflow_designs
       WHERE workflow_id = ${workflowId} ORDER BY revision`),
  );
}
