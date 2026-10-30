/**
 * A design the requirement an issue delivers links or pins, read through the issue. The job prompt
 * points a run at the designs its requirement's latest baseline pins; where that requirement is a
 * sibling project's (`requirements/issue-projects.ts`) the design is that project's too, and the
 * run's credential, fenced to the issue's project, was refused `PAT_PROJECT_OUTSIDE_FENCE` on the
 * project route. The caller authorises on the issue's project; this read answers one design the
 * issue's own requirement links or pins, as the steps view reads it, without the issues of that
 * project building it.
 */

import type { DesignStepsView } from '@forge/contracts/workflows';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notFound } from '../middleware/route-errors.js';
import { designView } from './design-service.js';
import { designReadOf } from './projection.js';
import { readWorkflow } from './store.js';

export interface IssueDesignRange {
  revision?: number | undefined;
  from?: number | undefined;
  to?: number | undefined;
}

/** What the read answers: the steps view of the design, and the project holding it, whose data policy it leaves under. */
export interface IssueDesignRead {
  projectId: string;
  design: Omit<DesignStepsView, 'builds'>;
}

/** Design `workflowId`, where the requirement `issueId` delivers links or pins it; the caller has authorised the issue. */
export async function issueRequirementDesignOf(
  issueId: string,
  workflowId: string,
  range: IssueDesignRange,
): Promise<IssueDesignRead> {
  const [req] = (await db.execute(sql`
    SELECT r.id, r.req_seq, p.slug, r.project_id <> i.project_id AS other,
           EXISTS (SELECT 1 FROM requirement_workflows rw
                    WHERE rw.requirement_id = r.id AND rw.workflow_id = ${workflowId}::uuid)
        OR EXISTS (SELECT 1 FROM requirement_baseline_pins bp
                    WHERE bp.requirement_id = r.id AND bp.workflow_id = ${workflowId}::uuid) AS reaches
      FROM issues i
      JOIN requirements r ON r.id = i.requirement_id
      JOIN projects p ON p.id = r.project_id
     WHERE i.id = ${issueId}
  `)) as unknown as Array<{ req_seq: number; slug: string; other: boolean; reaches: boolean }>;
  if (!req) {
    throw notFound(
      `issue ${issueId} delivers no requirement, so no design reads through it; read a design of this project on its own route`,
    );
  }
  const key = `${req.other ? `${req.slug}/` : ''}REQ-${req.req_seq}`;
  const row = req.reaches ? await readWorkflow(db, workflowId) : null;
  if (!row) {
    throw notFound(
      `workflow ${workflowId} is neither linked to nor pinned by ${key}, the requirement issue ${issueId} delivers, so it does not read through this issue`,
    );
  }
  const { builds: _builds, ...design } = designReadOf(await designView(row, null), 'steps', range);
  return { projectId: row.projectId, design: design as Omit<DesignStepsView, 'builds'> };
}
