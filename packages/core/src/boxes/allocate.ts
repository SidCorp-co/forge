// Where a device's waiting boxes go (ISS-1276, ADR 0015): the slot rule places them
// (`devices/run-slots.ts:slotsFor`, asked through `readBoxAllocation`), and this writes what it said:
// a box that fits starts, one that does not keeps its place and reason, and a served mode with no
// warm box gets one. A heartbeat's box health and the sweep each ask again, so a waiting box starts
// when health returns. The sweep also expires idle holds, fails a box that never came up, and drops
// the recordings of boxes whose issue ended.

import type { BoxFailure, BoxMode } from '@forge/contracts/boxes';
import { BOX_LIMITS, BOX_MACHINE, BOX_RUNNING_STATES } from '@forge/contracts/boxes';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type BoxRow, boxes } from '../db/schema-boxes.js';
import { type BoxDemandRow, boxDeviceOf, readBoxAllocation } from '../devices/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import { type KernelActor, transition } from '../lifecycle/index.js';
import { pushBox, SOURCE, tellChanged } from './access.js';
import { handBack } from './hold.js';
import { idleAgentBoxes, recordingsOfEndedIssues, unusedSince } from './read.js';
import { sendSession, sessionAtEnd, sweepSessions } from './session.js';

/** The devices kernel's port: every box on the device that is not over. */
export async function boxDemand(
  executor: Pick<Tx, 'execute'>,
  deviceId: string,
): Promise<BoxDemandRow[]> {
  const rows = (await executor.execute(sql`
    SELECT id::text AS id, project_id::text AS project_id, mode, state, asked_at, opened_at
      FROM boxes
     WHERE device_id = ${deviceId}
       AND state IN ('waiting', 'opening', 'warm', 'agent', 'person')`)) as unknown as Array<{
    id: string;
    project_id: string | null;
    mode: BoxMode;
    state: BoxDemandRow['state'];
    asked_at: Date | string;
    opened_at: Date | string | null;
  }>;
  return [...rows].map((r) => ({
    id: r.id,
    projectId: r.project_id,
    mode: r.mode,
    state: r.state,
    askedAt: new Date(r.asked_at),
    openedAt: r.opened_at === null ? null : new Date(r.opened_at),
  }));
}

const openFrame = (row: BoxRow, warm: boolean) => ({
  boxId: row.id,
  mode: row.mode,
  warm,
  // a warm box never records; another records from its start only where its open asked (ISS-1321)
  record: !warm && row.recordingWhy === 'asked',
  viewport: row.viewport ?? null,
  url: row.url,
  openTimeoutSeconds: BOX_LIMITS.openTimeoutSeconds,
  asPerson: row.openedAs === 'person',
});

/** Place every waiting box of the device, under its lock, and write what the rule said. */
export async function allocateDevice(
  deviceId: string,
  now = new Date(),
): Promise<{ started: number; waiting: number; warm: number }> {
  const device = await boxDeviceOf(deviceId);
  if (!device) return { started: 0, waiting: 0, warm: 0 };
  return db.transaction(async (tx) => {
    await lockXact(tx, 'boxes', deviceId);
    const plan = await readBoxAllocation(deviceId, { executor: tx, now });
    const system: KernelActor = { type: 'system' };
    if (plan.start.length > 0) {
      await transition(tx, BOX_MACHINE, {
        to: 'opening',
        from: 'waiting',
        where: and(eq(boxes.deviceId, deviceId), inArray(boxes.id, plan.start)),
        set: { openedAt: now, queue: null },
        actor: system,
        source: SOURCE,
        afterWrite: async (t, rows) => {
          for (const r of rows as BoxRow[]) {
            await pushBox(t, deviceId, 'box.open', openFrame(r, false));
            await tellChanged(t, { ...r, state: 'opening' });
          }
        },
      });
    }
    for (const [id, place] of plan.wait) {
      await tx
        .update(boxes)
        .set({ queue: place })
        .where(and(eq(boxes.id, id), eq(boxes.state, 'waiting')));
    }
    for (const mode of plan.warm) {
      const [row] = await tx
        .insert(boxes)
        .values({ deviceId, mode, state: 'opening', createdBy: device.ownerId, openedAt: now })
        .returning();
      if (row) await pushBox(tx, deviceId, 'box.open', openFrame(row, true));
    }
    return { started: plan.start.length, waiting: plan.wait.size, warm: plan.warm.length };
  });
}

/**
 * Fail a box by the kernel or the runner, naming why, and have the device reap what it started.
 * `onFailed` runs in the same transaction only when this call moved the row, so a second report of
 * one failure does nothing twice.
 */
export async function failBox(
  row: BoxRow,
  failure: BoxFailure,
  detail: string,
  actor: KernelActor,
  onFailed?: (tx: Tx) => Promise<void>,
): Promise<void> {
  if (row.state === 'closed' || row.state === 'failed' || row.state === 'waiting') return;
  const session = sessionAtEnd(row);
  await transition(db, BOX_MACHINE, {
    to: 'failed',
    expect: row.state,
    where: eq(boxes.id, row.id),
    set: {
      failure,
      detail: detail.slice(-4000),
      closedAt: new Date(),
      heldBy: null,
      heldSince: null,
      recordingState: row.recordingState === 'recording' ? 'kept' : row.recordingState,
      recordingWhy: null,
      ...session.set,
    },
    reason: failure,
    actor,
    source: SOURCE,
    afterWrite: async (tx, rows) => {
      for (const r of rows) {
        await pushBox(tx, row.deviceId, 'box.close', { boxId: r.id, why: 'failed' });
        if (session.send) await sendSession(tx, row);
        await tellChanged(tx, { ...row, ...r, state: 'failed' });
      }
      if (rows.length > 0) await onFailed?.(tx);
    },
  });
}

/**
 * A heartbeat stored the device's box health: a box the device said was up and no longer holds is
 * gone (`BOX_GONE`), and the waiting ones are placed again against the fresh measurement.
 */
export async function boxHealthBeat(deviceId: string): Promise<void> {
  const health = (await boxDeviceOf(deviceId))?.health ?? null;
  if (!health) return;
  const held = new Set(health.report.held);
  const running = await db
    .select()
    .from(boxes)
    .where(
      and(
        eq(boxes.deviceId, deviceId),
        inArray(boxes.state, [...BOX_RUNNING_STATES]),
        isNotNull(boxes.readyAt),
      ),
    );
  for (const row of running) {
    if (held.has(row.id)) continue;
    await failBox(row, 'BOX_GONE', 'the device no longer lists this box among those it holds', {
      type: 'runner',
      id: deviceId,
    });
  }
  await allocateDevice(deviceId);
}

/**
 * Close an agent's box nothing used for `agentIdleSeconds`, on the record, and have its device reap
 * it (ISS-1335): its opener may be gone, or refused every call after its open.
 */
async function closeIdle(row: BoxRow, since: Date, actor: KernelActor): Promise<boolean> {
  const session = sessionAtEnd(row);
  const moved = await transition(db, BOX_MACHINE, {
    to: 'closed',
    expect: 'agent',
    recovery: true,
    where: and(eq(boxes.id, row.id), unusedSince(since)),
    set: {
      closedAt: new Date(),
      closedWhy: 'idle',
      queue: null,
      recordingState: row.recordingState === 'recording' ? 'kept' : row.recordingState,
      recordingWhy: null,
      ...session.set,
    },
    reason: `nothing used it for ${BOX_LIMITS.agentIdleSeconds}s: closed idle`,
    actor,
    source: SOURCE,
    afterWrite: async (tx, rows) => {
      for (const r of rows) {
        await pushBox(tx, row.deviceId, 'box.close', { boxId: r.id, why: 'idle' });
        if (session.send) await sendSession(tx, row);
        await tellChanged(tx, { ...row, ...r, state: 'closed' });
      }
    },
  });
  // a box used or taken since the select is left as it stands: its move matched no row
  return moved.rows.length > 0;
}

/**
 * The sweep: idle holds expire, idle agent boxes close, boxes that never came up fail, recordings a
 * device never sent say why (ISS-1338), ended issues' recordings go.
 */
export async function sweepBoxes(now = new Date()): Promise<{ moved: number }> {
  let moved = 0;
  const sweeper: KernelActor = { type: 'sweeper' };
  const idle = await db
    .select()
    .from(boxes)
    .where(
      and(
        eq(boxes.state, 'person'),
        lt(boxes.lastInputAt, new Date(now.getTime() - BOX_LIMITS.holdIdleSeconds * 1000)),
      ),
    );
  for (const row of idle) {
    await handBack(row, 'expired', sweeper);
    moved++;
  }
  const unusedFrom = new Date(now.getTime() - BOX_LIMITS.agentIdleSeconds * 1000);
  for (const row of await idleAgentBoxes(unusedFrom)) {
    if (await closeIdle(row, unusedFrom, sweeper)) moved++;
  }
  const stuck = await db
    .select()
    .from(boxes)
    .where(
      and(
        eq(boxes.state, 'opening'),
        lt(boxes.openedAt, new Date(now.getTime() - BOX_LIMITS.openTimeoutSeconds * 1000)),
      ),
    );
  for (const row of stuck) {
    await failBox(
      row,
      'START_FAILED',
      `the device did not report it ready within ${BOX_LIMITS.openTimeoutSeconds}s`,
      sweeper,
    );
    moved++;
  }
  moved += await sweepSessions(now);
  for (const r of await recordingsOfEndedIssues()) {
    await db.transaction(async (tx) => {
      await tx.update(boxes).set({ recordingState: 'dropped' }).where(eq(boxes.id, r.id));
      await pushBox(tx, r.deviceId, 'box.recording.drop', { boxId: r.id });
    });
    moved++;
  }
  const waitingOn = await db
    .selectDistinct({ deviceId: boxes.deviceId })
    .from(boxes)
    .where(eq(boxes.state, 'waiting'));
  for (const { deviceId } of waitingOn) {
    try {
      moved += (await allocateDevice(deviceId, now)).started;
    } catch (err) {
      logger.warn({ err, deviceId }, 'box-sweep: allocation failed');
    }
  }
  return { moved };
}
