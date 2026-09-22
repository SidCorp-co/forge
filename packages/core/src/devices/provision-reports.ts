/**
 * A runner row's reports, written once: one row can be short its ssh key AND
 * unable to mint, and a write per report would leave only the last. Each row is
 * its own attempt and nothing is raised — a lock wait on one must not cost the
 * device its provisions (ISS-1184) — and what was not written says so and is
 * never terminal, nothing having left the queue.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import type { ProvisionReport } from './provision-row.js';

const DETAIL_MAX = 2000;

export async function recordProvisionReports(
  reports: readonly ProvisionReport[],
): Promise<ProvisionReport[]> {
  const byRunner = new Map<string, ProvisionReport[]>();
  for (const report of reports) {
    const group = byRunner.get(report.runnerId);
    if (group) group.push(report);
    else byRunner.set(report.runnerId, [report]);
  }

  const out: ProvisionReport[] = [];
  for (const [runnerId, group] of byRunner) {
    const detail = group
      .map((r) => r.reason)
      .join(' \u00b7 ')
      .slice(0, DETAIL_MAX);
    const terminal = group.some((r) => r.terminal);
    try {
      await db
        .update(runners)
        .set({
          provisionDetail: detail,
          updatedAt: new Date(),
          ...(terminal ? { provisionStatus: 'failed' as const } : {}),
        })
        .where(eq(runners.id, runnerId));
      out.push(...group);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      out.push(
        ...group.map((r) => ({
          ...r,
          terminal: false,
          reason: `${r.reason} \u2014 not recorded on the runner row: ${why}`,
        })),
      );
    }
  }
  return out;
}
