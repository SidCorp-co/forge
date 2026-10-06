/**
 * Which returned designs owe their project master a revision (workflow project-onboarding
 * `decided`: a returned design goes back to revision). The box carrying the master reads it on
 * every sweep, so a return is master work whether or not its workflow.designDecided wake was heard.
 * A design drawn under a live issue is that issue's to carry, and the return already reopened it or
 * said so on it (`design-issue.ts:handBack`), so only a return no live issue holds is owed
 * here; proposing the next revision is what takes it off.
 */

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface OwedDesignRevision {
  workflowId: string;
  flow: string;
  revision: number;
  reason: string;
  returnedAt: string;
}

const TERMINAL = sql.join(
  ISSUE_TERMINAL_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

export async function owedDesignRevisions(projectId: string): Promise<OwedDesignRevision[]> {
  const rows = (await db.execute(sql`
    SELECT w.id AS workflow_id, w.flow, d.revision, d.reason, d.decided_at
      FROM project_workflows w
      JOIN LATERAL (
        SELECT revision, decision, reason, decided_at, design_issue_id
          FROM project_workflow_designs
         WHERE workflow_id = w.id
         ORDER BY revision DESC
         LIMIT 1
      ) d ON true
      LEFT JOIN issues i ON i.id = d.design_issue_id AND i.archived_at IS NULL
     WHERE w.project_id = ${projectId}
       AND w.design_status = 'returned'
       AND d.decision = 'return'
       AND (i.id IS NULL OR i.status IN (${TERMINAL}))
     ORDER BY d.decided_at, w.flow
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    workflowId: String(r.workflow_id),
    flow: String(r.flow),
    revision: Number(r.revision),
    reason: String(r.reason ?? ''),
    returnedAt: new Date(r.decided_at as string).toISOString(),
  }));
}
