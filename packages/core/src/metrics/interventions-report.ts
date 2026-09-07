/**
 * The interventions metric (VISION §1 metric ②), read and rolled up.
 *
 * ISS-944 — this lived inside the `/api/pipeline/interventions` handler, which
 * is a cross-project fan-out and therefore off `PAT_ALLOWED_PREFIXES`, so the
 * one metric the project calls its north star had no shape any token could
 * reach. Moved here so the fan-out and the project-scoped twin in `routes.ts`
 * answer from one query and one rollup rather than two copies of the
 * bucketing.
 *
 * Reads the `issue_intervention_events` view: one row per intervention-class
 * event — `wedge` (pipeline_wedge notifications), `manual_<action>` (C0's
 * audited job_events.kind='intervention', labelled by the row's own action
 * since migration 0181), `user_run_flip` (C1 kernel_transitions, entity='run',
 * actor_type='user') and `direct_sql` (ISS-884: a terminal flip on a job or run
 * that no `applyKernelTransition` transaction produced, i.e. written by hand).
 * `issueId: null` groups the project-scoped events (pm/system runs).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// cm:edge contract -> packages/core/drizzle/migrations/0217_unaudited_transition_detector.sql — the view is what decides these strings, and `manual_` is a PREFIX with the action appended, not a fixed value. This union read `'manual_cancel'` until ISS-884 while 0181 had been emitting `manual_resume` / `manual_answer` / `manual_inject` for months, and the rollup below charted every one of them as a run flip.
type EventRow = {
  source: 'wedge' | `manual_${string}` | 'user_run_flip' | 'direct_sql';
  project_id: string;
  issue_id: string | null;
  occurred_at: string;
  detail: string | null;
};

export interface InterventionEvent {
  source: EventRow['source'];
  projectId: string;
  issueId: string | null;
  occurredAt: string;
  detail: string | null;
}

export interface InterventionsByIssue {
  issueId: string | null;
  projectId: string;
  wedges: number;
  manualJobActions: number;
  userRunFlips: number;
  directSql: number;
  total: number;
  lastAt: string;
}

export interface InterventionsReport {
  total: number;
  byIssue: InterventionsByIssue[];
  events: InterventionEvent[];
}

export async function buildInterventionsReport(
  projectIds: readonly string[],
  days: number,
): Promise<InterventionsReport> {
  if (projectIds.length === 0) return { total: 0, byIssue: [], events: [] };

  const rows = await db.execute(sql`
    SELECT source, project_id, issue_id, occurred_at, detail
    FROM issue_intervention_events
    WHERE project_id IN ${projectIds}
      AND occurred_at >= now() - (${days}::int * interval '1 day')
    ORDER BY occurred_at DESC
    LIMIT 2000
  `);

  const events: InterventionEvent[] = (rows as unknown as EventRow[]).map((r) => ({
    source: r.source,
    projectId: r.project_id,
    issueId: r.issue_id,
    occurredAt: r.occurred_at,
    detail: r.detail,
  }));

  const byIssueMap = new Map<string, InterventionsByIssue>();
  for (const e of events) {
    const key = `${e.projectId}:${e.issueId ?? ''}`;
    const agg = byIssueMap.get(key) ?? {
      issueId: e.issueId,
      projectId: e.projectId,
      wedges: 0,
      manualJobActions: 0,
      userRunFlips: 0,
      directSql: 0,
      total: 0,
      lastAt: e.occurredAt,
    };
    if (e.source === 'wedge') agg.wedges++;
    else if (e.source.startsWith('manual_')) agg.manualJobActions++;
    else if (e.source === 'direct_sql') agg.directSql++;
    else agg.userRunFlips++;
    agg.total++;
    if (e.occurredAt > agg.lastAt) agg.lastAt = e.occurredAt;
    byIssueMap.set(key, agg);
  }

  return {
    total: events.length,
    byIssue: [...byIssueMap.values()].sort((a, b) => b.total - a.total),
    events,
  };
}
