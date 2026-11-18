// What the device reports about a box it was told to run (`POST /api/boxes/:id/report`, device
// credential; `@forge/contracts/box-wire:boxReportSchema`). The device says what happened; core
// moves the record. A device answers only for the boxes it holds.

import type { BoxReport } from '@forge/contracts/box-wire';
import { BOX_MACHINE, type BoxRecord } from '@forge/contracts/boxes';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type BoxRow, boxes } from '../db/schema-boxes.js';
import { type KernelActor, transition } from '../lifecycle/index.js';
import { refuse, SOURCE, tellChanged } from './access.js';
import { completeAct } from './acts.js';
import { failBox } from './allocate.js';
import { boxById, boxRecord } from './read.js';
import { failSpan, recordMark } from './spans.js';

/**
 * Opening → running: a warm box, a person's box to test by hand, or the agent's. A running box's
 * `ready` answers its assignment (`box.assign`): a warm box's evidence restarts at the hand-out, so
 * the record's recording start moves to the instant the device restarted it (ISS-1315).
 */
async function ready(
  row: BoxRow,
  report: Extract<BoxReport, { kind: 'state' }>,
  device: KernelActor,
): Promise<void> {
  if ((row.state === 'agent' || row.state === 'person') && report.recordingStartedAt) {
    await db
      .update(boxes)
      .set({
        recordingStartedAt: new Date(report.recordingStartedAt),
        view: report.offer ?? row.view,
      })
      .where(eq(boxes.id, row.id));
    return;
  }
  if (row.state !== 'opening') return;
  const now = new Date();
  const to = row.projectId === null ? 'warm' : row.openedAs === 'person' ? 'person' : 'agent';
  await transition(db, BOX_MACHINE, {
    to,
    expect: 'opening',
    where: eq(boxes.id, row.id),
    set: {
      readyAt: now,
      view: report.offer ?? row.view,
      recordingState: 'recording',
      recordingStartedAt: report.recordingStartedAt ? new Date(report.recordingStartedAt) : now,
      ...(to === 'person' ? { heldBy: row.createdBy, heldSince: now, lastInputAt: now } : {}),
    },
    actor: device,
    source: SOURCE,
    afterWrite: async (tx, rows) => {
      for (const r of rows) {
        await tellChanged(tx, {
          ...row,
          ...r,
          state: to,
          heldBy: to === 'person' ? row.createdBy : null,
        });
      }
    },
  });
}

export async function reportBox(
  deviceId: string,
  boxId: string,
  report: BoxReport,
): Promise<BoxRecord> {
  const row = await boxById(boxId);
  if (!row || row.deviceId !== deviceId) {
    throw refuse('BOX_NOT_FOUND', `no box ${boxId} is held by this device`);
  }
  const device: KernelActor = { type: 'runner', id: deviceId };
  switch (report.kind) {
    case 'state':
      if (report.state === 'ready') await ready(row, report, device);
      else {
        await failBox(
          row,
          report.state === 'gone' ? 'BOX_GONE' : (report.failure ?? 'START_FAILED'),
          report.detail ?? `the device reported the box ${report.state}`,
          device,
        );
      }
      break;
    case 'offer':
      await db.update(boxes).set({ view: report.offer }).where(eq(boxes.id, row.id));
      break;
    case 'act':
      await completeAct(row, report);
      break;
    case 'mark':
      await recordMark(row, report);
      break;
    case 'clip_failed':
      await failSpan(row, report.spanId, report.detail);
      break;
  }
  return boxRecord((await boxById(boxId)) ?? row);
}
