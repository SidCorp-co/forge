import { type RequirementState, requirementKey } from '@forge/contracts/requirements';
import type { DesignRequirementLink } from '@forge/contracts/workflows';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementStatesOf } from './ports.js';

type LinkRow = {
  id: string;
  project_id: string;
  req_seq: number;
  title: string;
  status: string;
  pinned: number | null;
};

function stateUnread(r: LinkRow): never {
  throw new Error(
    `requirement ${r.id} (${requirementKey(Number(r.req_seq))}) is linked to this design and its standing read no state for it`,
  );
}

// The badge is the requirement's state as its own page reads it, never the stored status. The pin
// is the one the requirement's latest baseline holds for this design, as the requirement's own
// standing reads it (`requirements/standing-facts.ts:latestPinsOf`); a requirement agreed before the
// link pins nothing
export async function designRequirementsOf(workflowId: string): Promise<DesignRequirementLink[]> {
  const rows = (await db.execute(sql`
    SELECT r.id, r.project_id, r.req_seq, r.title, r.status, p.design_revision AS pinned
      FROM requirement_workflows rw
      JOIN requirements r ON r.id = rw.requirement_id
      LEFT JOIN LATERAL (
        SELECT b.revision, b.seq FROM requirement_baselines b
         WHERE b.requirement_id = r.id
         ORDER BY b.revision DESC, b.seq DESC LIMIT 1) lb ON true
      LEFT JOIN requirement_baseline_pins p
        ON p.requirement_id = r.id AND p.revision = lb.revision
       AND p.baseline_seq = lb.seq AND p.workflow_id = rw.workflow_id
     WHERE rw.workflow_id = ${workflowId}
     ORDER BY r.req_seq`)) as unknown as LinkRow[];
  const states = new Map<string, RequirementState>();
  for (const projectId of new Set(rows.map((r) => r.project_id))) {
    const ids = rows.filter((r) => r.project_id === projectId).map((r) => r.id);
    for (const [id, state] of await requirementStatesOf(projectId, ids)) states.set(id, state);
  }
  return [...rows].map((r) => ({
    key: requirementKey(Number(r.req_seq)),
    title: r.title,
    status: r.status,
    state: states.get(r.id) ?? stateUnread(r),
    pinnedRevision: r.pinned === null ? null : Number(r.pinned),
  }));
}

/** Each listed design's linked requirement keys, in key order: one read for the whole list. */
export async function requirementKeysOf(
  workflowIds: readonly string[],
): Promise<Map<string, string[]>> {
  const keys = new Map<string, string[]>(workflowIds.map((id) => [id, []]));
  if (workflowIds.length === 0) return keys;
  const rows = (await db.execute(sql`
    SELECT rw.workflow_id, r.req_seq
      FROM requirement_workflows rw
      JOIN requirements r ON r.id = rw.requirement_id
     WHERE rw.workflow_id IN (${sql.join(
       workflowIds.map((id) => sql`${id}`),
       sql`, `,
     )})
     ORDER BY r.req_seq`)) as unknown as { workflow_id: string; req_seq: number }[];
  for (const r of rows) keys.get(r.workflow_id)?.push(requirementKey(Number(r.req_seq)));
  return keys;
}
