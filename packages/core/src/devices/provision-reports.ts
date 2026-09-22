/**
 * One provision report per runner row: each its own attempt, nothing raised,
 * and one that could not be written says so and is never terminal — a lock wait
 * on one row must not cost the device its provisions (ISS-1184).
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import type { ProvisionReport } from './provision-row.js';

const DETAIL_MAX = 2000;

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
