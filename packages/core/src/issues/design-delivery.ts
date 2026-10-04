import { type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';

export interface DesignHold {
  readonly workflowId: string;
  readonly flow: string;
  readonly revision: number;
  readonly decision: 'return' | null;
}

const latestVerdictDesign = sql`
  JOIN LATERAL (
    SELECT cv.identity_kind, cv.design_workflow_id, cv.design_revision
      FROM criterion_verdicts cv
     WHERE cv.criterion_id = c.id
     ORDER BY cv.created_at DESC, cv.id DESC
     LIMIT 1
  ) v ON v.identity_kind = 'design'`;

const unapproved = (alias: SQL) => sql`NOT EXISTS (
  SELECT 1 FROM project_workflow_designs a
   WHERE a.workflow_id = ${alias}.workflow_id
     AND a.revision = ${alias}.revision
     AND a.decision = 'approve'
)`;

// cm:why an issue delivers a design revision when it is that revision's design issue (the latest it
// proposed, per workflow) or when the latest verdict on one of its live criteria names a design
// revision (a design verdict counts on any issue, ISS-91); either way the work it owes is that
// revision approved, so a blocks edge from it holds until then (FB-57)
function deliveredBy(issueId: SQL): SQL {
  return sql`(
    SELECT d.workflow_id, max(d.revision) AS revision
      FROM project_workflow_designs d
     WHERE d.design_issue_id = ${issueId}
     GROUP BY d.workflow_id
    UNION
    SELECT v.design_workflow_id, v.design_revision
      FROM issue_criteria c ${latestVerdictDesign}
     WHERE c.issue_id = ${issueId} AND c.retired_at IS NULL
  )`;
}

export function designHeldSql(issueId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${deliveredBy(issueId)} dl
     WHERE ${unapproved(sql`dl`)}
  )`;
}

export async function designHoldsOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Map<string, DesignHold[]>> {
  const out = new Map<string, DesignHold[]>();
  if (issueIds.length === 0) return out;
  const ids = sql.join(
    [...new Set(issueIds)].map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await executor.execute(sql`
    SELECT x.id AS issue_id, dl.workflow_id, w.flow, dl.revision, d.decision
      FROM unnest(ARRAY[${ids}]) AS x(id)
      CROSS JOIN LATERAL ${deliveredBy(sql`x.id`)} dl
      JOIN project_workflows w ON w.id = dl.workflow_id
      LEFT JOIN project_workflow_designs d ON d.workflow_id = dl.workflow_id AND d.revision = dl.revision
     WHERE ${unapproved(sql`dl`)}
     ORDER BY w.flow, dl.revision`)) as unknown as Array<Record<string, unknown>>;
  for (const r of rows) {
    const issueId = String(r.issue_id);
    const hold: DesignHold = {
      workflowId: String(r.workflow_id),
      flow: String(r.flow),
      revision: Number(r.revision),
      decision: r.decision === 'return' ? 'return' : null,
    };
    out.set(issueId, [...(out.get(issueId) ?? []), hold]);
  }
  return out;
}

export function designHoldPhrase(holds: readonly DesignHold[]): string {
  return holds
    .map(
      (h) =>
        `design ${h.flow} rev ${h.revision} ${h.decision === 'return' ? 'was returned' : 'is not approved'}`,
    )
    .join('; ');
}
