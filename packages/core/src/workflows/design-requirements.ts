import { requirementKey } from '@forge/contracts/requirements';
import type { DesignRequirementLink } from '@forge/contracts/workflows';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

type LinkRow = {
  req_seq: number;
  title: string;
  status: string;
  pinned: number | null;
};

// The pin is the one the requirement's latest baseline holds for this design, as the
// requirement's own standing reads it (`requirements/standing-facts.ts:latestPinsOf`); a requirement
// agreed before the link pins nothing
export async function designRequirementsOf(workflowId: string): Promise<DesignRequirementLink[]> {
  const rows = (await db.execute(sql`
    SELECT r.req_seq, r.title, r.status, p.design_revision AS pinned
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
  return [...rows].map((r) => ({
    key: requirementKey(Number(r.req_seq)),
    title: r.title,
    status: r.status,
    pinnedRevision: r.pinned === null ? null : Number(r.pinned),
  }));
}
