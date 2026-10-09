/**
 * The boot reconciliation of BC-23: a pin-only revision already waiting on a person when the rule
 * shipped is approved by the same path a new one takes (`design-pin-only.ts:settlePinOnly`), never by
 * a row written around it. Idempotent, so it runs at every boot and a boot with nothing waiting writes
 * nothing.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settlePinOnly } from './design-pin-only.js';
import { templatesOf } from './service.js';
import { lockWorkflows } from './store.js';

export interface PinOnlyReconciled {
  projects: number;
  approved: { workflowId: string; flow: string; revision: number }[];
  refused: { workflowId: string; code: string; detail: string }[];
}

export async function reconcilePinOnlyDesigns(): Promise<PinOnlyReconciled> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT project_id FROM project_workflows
     WHERE design_status = 'proposed' AND approved_revision IS NOT NULL
     ORDER BY project_id`)) as unknown as { project_id: string }[];
  const out: PinOnlyReconciled = { projects: rows.length, approved: [], refused: [] };
  for (const { project_id: projectId } of rows) {
    const { templates } = await templatesOf(projectId);
    const settled = await db.transaction(async (tx) => {
      await lockWorkflows(tx, projectId);
      return settlePinOnly(tx, projectId, templates);
    });
    out.approved.push(...settled.approved);
    out.refused.push(
      ...settled.refused.map((r) => ({
        workflowId: r.workflowId,
        code: r.refusal.code,
        detail: r.refusal.detail,
      })),
    );
  }
  return out;
}
