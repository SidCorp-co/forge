// A declared gate check a release went past, as cleanup debt (REQ-79 r6 BC-12, BC-16; owner ruling
// 2026-10-31): outside strict only the build and a healthy deploy hold a release, so where the
// project's declared validation gate (`validation.gate`) is not a pass at the commit a release or an
// on-land deploy puts out, the release goes and the reading is left for the cleanup lane. Every door
// that reads the gate reads it again, so one check at one place is one open debt, never one per read.

import type { DebtItem } from '@forge/contracts/cleanup';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { insertDebts, openDebtStands } from './store.js';

/** One reading of the declared gate that is not a pass, as the door that read it says it. */
export interface GateDebt {
  projectId: string;
  /** `red`: the check ended red; `debt`: it was still running, never reported, or could not be read. */
  kind: Extract<DebtItem['kind'], 'red' | 'debt'>;
  check: string;
  /** The commit it was read at, or where the host was asked when no commit was known. */
  where: string;
  /** What the gate said, in the words the refusal under strict says it. */
  detail: string;
}

const UNRATED =
  'Recorded by Forge, rated by no agent: a release went past the declared gate check outside ' +
  'strict (REQ-79 r6 BC-16); the cleanup run reads it and rates or clears it.';

/** Write the debt unless the same one stands open; answers whether it was written. */
export async function recordGateDebt(debt: GateDebt): Promise<boolean> {
  const where = debt.where.slice(0, 500);
  const written = await db.transaction(async (tx) => {
    // two doors reading one head at once leave one debt between them
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`gate-debt:${debt.projectId}:${debt.check}:${where}`}))`,
    );
    const key = { projectId: debt.projectId, kind: debt.kind, check: debt.check, where };
    if (await openDebtStands(tx, key)) return false;
    await insertDebts(tx, {
      projectId: debt.projectId,
      issueId: null,
      recordedBy: null,
      items: [
        {
          kind: debt.kind,
          check: debt.check,
          where,
          detail: debt.detail.slice(0, 2000),
          impact: { type: 'logic', rating: 'medium', reason: UNRATED },
        },
      ],
    });
    return true;
  });
  return written;
}
