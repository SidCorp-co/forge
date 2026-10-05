/**
 * Whether an issue's requirement changed since its plan was written (workflow
 * requirement-to-delivery, step `impact`): read for the issue reads and for the awaiting_release
 * guard alike, so the flag a reader sees is the one the gate refuses on. Only a later revision that
 * changed a BC the issue traces flags it.
 */

import { type ChangedTrace, changedSincePlan } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';

interface PlanDrift {
  key: string;
  plannedRevision: number | null;
  currentRevision: number | null;
  changed: boolean;
  /** The traced BCs a revision after the plan's, up to the head, reworded or removed. */
  changedCriteria: ChangedTrace[];
  detail: string;
}

type Executor = Pick<Tx, 'execute'>;

/**
 * For each of `issueIds`, the BCs its live criteria trace that a revision after its planned
 * revision, at or before its requirement's head, retired (reworded or removed). An issue with none
 * is absent from the map.
 */
export async function changedTracedOf(
  executor: Executor,
  issueIds: readonly string[],
): Promise<Map<string, ChangedTrace[]>> {
  const out = new Map<string, ChangedTrace[]>();
  if (issueIds.length === 0) return out;
  const rows = (await executor.execute(sql`
    SELECT DISTINCT c.issue_id, rc.code, rc.retired_revision
      FROM issue_criteria c
      JOIN issues i ON i.id = c.issue_id
      JOIN requirements r ON r.id = i.requirement_id
      JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id AND rc.requirement_id = r.id
     WHERE c.issue_id IN (${sql.join(
       issueIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND c.retired_at IS NULL
       AND i.planned_revision IS NOT NULL
       AND rc.retired_revision > i.planned_revision
       AND rc.retired_revision <= r.current_revision
     ORDER BY c.issue_id, rc.retired_revision, rc.code
  `)) as unknown as Array<{ issue_id: string; code: string; retired_revision: number }>;
  for (const r of rows) {
    const list = out.get(r.issue_id) ?? [];
    list.push({ code: r.code, revision: Number(r.retired_revision) });
    out.set(r.issue_id, list);
  }
  return out;
}

const changedPhrase = (changed: readonly ChangedTrace[]) =>
  changed.map((c) => `${c.code} changed in revision ${c.revision}`).join(', ');

/** The plan drift of `issueId`, or null when it delivers no requirement. */
export async function planDriftOf(executor: Executor, issueId: string): Promise<PlanDrift | null> {
  const [r] = (await executor.execute(sql`
    SELECT r.req_seq, r.current_revision, i.planned_revision,
           CASE WHEN btrim(coalesce(i.plan, '')) <> '' THEN i.plan END AS plan
    FROM issues i
    JOIN requirements r ON r.id = i.requirement_id
    WHERE i.id = ${issueId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!r) return null;
  const num = (v: unknown) => (v == null ? null : Number(v));
  const key = `REQ-${Number(r.req_seq)}`;
  const plannedRevision = num(r.planned_revision);
  const currentRevision = num(r.current_revision);
  const changedCriteria = (await changedTracedOf(executor, [issueId])).get(issueId) ?? [];
  const changed = changedSincePlan({
    plan: r.plan == null ? null : String(r.plan),
    plannedRevision,
    currentRevision,
    changedTraced: changedCriteria,
  });
  return {
    key,
    plannedRevision,
    currentRevision,
    changed,
    changedCriteria,
    detail:
      plannedRevision === null
        ? `${key} stands at revision ${currentRevision ?? 'none'}, but this issue's plan names no revision, so nothing says which BCs it was written against; re-plan against the current revision.`
        : `${key} stands at revision ${currentRevision ?? 'none'}, and this issue's plan was written against revision ${plannedRevision}; since then ${changedPhrase(changedCriteria) || 'no BC it traces changed'}. Re-plan against the current revision.`,
  };
}
