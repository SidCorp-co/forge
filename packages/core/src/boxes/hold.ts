// The hand-back from a person to the agent (ISS-1276): by the holder (`box.released`) or by the sweep
// when the hold went idle (`box.expired`, the recovery move). Recorded either way, and the device is
// told to refuse the person's input from now.

import { BOX_LIMITS, BOX_MACHINE, type BoxRecord } from '@forge/contracts/boxes';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type BoxRow, boxes } from '../db/schema-boxes.js';
import { type KernelActor, movedRow, transition } from '../lifecycle/index.js';
import { pushBox, SOURCE, tellChanged } from './access.js';
import { boxRecord } from './read.js';

/** Person → agent, by the holder or by the sweep when the hold went idle; recorded either way. */
export async function handBack(
  row: BoxRow,
  why: 'released' | 'expired',
  actor: KernelActor,
): Promise<BoxRecord> {
  const moved = await transition(db, BOX_MACHINE, {
    to: 'agent',
    expect: 'person',
    recovery: why === 'expired',
    where: eq(boxes.id, row.id),
    set: { heldBy: null, heldSince: null },
    reason:
      why === 'expired'
        ? `no input for ${BOX_LIMITS.holdIdleSeconds}s: the hold expired back to the agent`
        : null,
    actor,
    source: SOURCE,
    afterWrite: async (tx, rows) => {
      for (const r of rows) {
        await pushBox(tx, row.deviceId, 'box.release', { boxId: r.id, why });
        await tellChanged(tx, { ...row, ...r, state: 'agent', heldBy: null });
      }
    },
  });
  return boxRecord(movedRow(moved) as BoxRow);
}
