/**
 * Whether a design is rooted (design-reconciliation `rooted`, REQ-18 BC-2): it has an approved
 * revision and serves at least one requirement. An unrooted design is never observed, because there
 * is nothing planned to diff the code against.
 */

import { requirementKey } from '@forge/contracts/requirements';
import type { RootGap, WorkflowRootedView } from '@forge/contracts/workflow-health';
import { sql } from 'drizzle-orm';
import type { db, Tx } from '../db/client.js';
import type { ObservationRefusal } from './observation-rules.js';

export function rootGapsOf(approvedRevision: number | null, requirements: number): RootGap[] {
  const missing: RootGap[] = [];
  if (approvedRevision === null) missing.push('approved_revision');
  if (requirements === 0) missing.push('requirement');
  return missing;
}

export async function rootedOf(
  executor: Tx | typeof db,
  workflow: { id: string; approvedRevision: number | null },
): Promise<WorkflowRootedView> {
  const rows = (await executor.execute(sql`
    SELECT r.req_seq FROM requirement_workflows rw
      JOIN requirements r ON r.id = rw.requirement_id
     WHERE rw.workflow_id = ${workflow.id} AND r.status <> 'dropped'
     ORDER BY r.req_seq`)) as unknown as { req_seq: number }[];
  const requirements = [...rows].map((r) => requirementKey(Number(r.req_seq)));
  const missing = rootGapsOf(workflow.approvedRevision, requirements.length);
  return {
    rooted: missing.length === 0,
    approvedRevision: workflow.approvedRevision,
    requirements,
    missing,
  };
}

const ROOT_FIX: Record<RootGap, string> = {
  approved_revision:
    'it has no approved revision: a holder of workflow-designs.approve approves one first (POST …/design/decision)',
  requirement:
    'no requirement links it: the BA links each requirement it serves first (POST requirements/:req/workflows)',
};

export function unrootedRefusal(
  flow: string,
  rooted: WorkflowRootedView,
): ObservationRefusal | null {
  if (rooted.rooted) return null;
  return {
    code: 'WORKFLOW_OBSERVATION_UNROOTED',
    path: '',
    detail: `${flow} is not rooted, so there is nothing planned to observe against: ${rooted.missing.map((g) => ROOT_FIX[g]).join('; ')}.`,
  };
}
