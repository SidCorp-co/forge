/**
 * Where a provision report is left for an operator who does not have this
 * response in hand: on the runner row, which the project's runner page renders
 * and which is the only carrier for a report the header's budget dropped.
 *
 * A report whose cause reproduced also takes its row out of the queue, so it
 * stops being re-read every ninety seconds; re-binding puts it back at `queued`
 * with a clean detail.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import type { ProvisionReport } from './provision-row.js';

/** What `runners.provision_detail` holds. */
const DETAIL_MAX = 2000;

/**
 * Each row on its own, and nothing raised. This write is a diagnostic: a lock
 * wait on one runner row must not cost the device the provisions already built,
 * which is the defect this endpoint is being fixed for (ISS-1184). A report it
 * could not write comes back saying so, and is never called terminal — nothing
 * was recorded, so nothing left the queue.
 */
export async function recordProvisionReports(
  reports: readonly ProvisionReport[],
): Promise<ProvisionReport[]> {
  const out: ProvisionReport[] = [];
  for (const report of reports) {
    try {
      await db
        .update(runners)
        .set({
          provisionDetail: report.reason.slice(0, DETAIL_MAX),
          updatedAt: new Date(),
          ...(report.terminal ? { provisionStatus: 'failed' as const } : {}),
        })
        .where(eq(runners.id, report.runnerId));
      out.push(report);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      out.push({
        ...report,
        terminal: false,
        reason: `${report.reason} — not recorded on the runner row: ${why}`,
      });
    }
  }
  return out;
}
