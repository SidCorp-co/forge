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
import { allocateDevice, failBox } from './allocate.js';
import { recordCdpActs } from './attach.js';
import { boxById, boxRecord } from './read.js';
import { recordingReport } from './recording.js';
import { failSpan, recordMark } from './spans.js';

/**
 * Opening → running: a warm box, a person's box to test by hand, or the agent's, and a warm box
 * handed out, whose `ready` answers its `box.assign` once the device found its screen answering
 * (ISS-1324). It records only where the device says its recording started (ISS-1321).
 */
async function ready(
  row: BoxRow,
  report: Extract<BoxReport, { kind: 'state' }>,
  device: KernelActor,
): Promise<void> {
  if (row.state !== 'opening') return;
  const now = new Date();
  const to = row.projectId === null ? 'warm' : row.openedAs === 'person' ? 'person' : 'agent';
  const recorded = report.recordingStartedAt ? new Date(report.recordingStartedAt) : null;
  await transition(db, BOX_MACHINE, {
    to,
    expect: 'opening',
    where: eq(boxes.id, row.id),
    set: {
      readyAt: now,
      view: report.offer ?? row.view,
      ...(report.attach ? { attach: report.attach } : {}),
      ...(recorded
        ? { recordingState: 'recording' as const, recordingStartedAt: recorded }
        : { recordingWhy: null }),
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

/**
 * The device found the box's screen gone (ISS-1324): it fails `BOX_DEVICE_GONE` by name and is
 * never handed out. A request it was being handed to goes on as a fresh box, which its failure
 * names, and the allocation starts it and a new warm box in its place.
 */
async function deviceGone(row: BoxRow, said: string | undefined, device: KernelActor) {
  if (row.state === 'closed' || row.state === 'failed') return;
  const words = said ?? "the device found the box's screen no longer answering";
  let detail = words;
  if (row.projectId !== null) {
    const [next] = await db
      .insert(boxes)
      .values({
        deviceId: row.deviceId,
        projectId: row.projectId,
        issueId: row.issueId,
        criterion: row.criterion,
        mode: row.mode,
        state: 'waiting',
        openedAs: row.openedAs,
        runId: row.runId,
        url: row.url,
        viewport: row.viewport,
        recordingWhy: row.recordingWhy === 'asked' ? 'asked' : null,
        createdBy: row.createdBy,
      })
      .returning({ id: boxes.id });
    if (next) detail = `${words}. Its request goes on as box ${next.id}: read that one`;
  }
  await failBox(row, 'BOX_DEVICE_GONE', detail, device);
  await allocateDevice(row.deviceId);
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
      else if (report.failure === 'BOX_DEVICE_GONE') await deviceGone(row, report.detail, device);
      else {
        await failBox(
          row,
          report.state === 'gone' ? 'BOX_GONE' : (report.failure ?? 'START_FAILED'),
          report.detail ?? `the device reported the box ${report.state}`,
          device,
        );
      }
      break;
    case 'recording':
      await recordingReport(row, report);
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
    case 'cdp':
      await recordCdpActs(row, report);
      break;
  }
  return boxRecord((await boxById(boxId)) ?? row);
}
