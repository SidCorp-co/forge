// A box's recording is optional (ISS-1321; owner 2026-11-18: recording costs resources). Nothing
// records by default and a warm box never does. It runs when an open asks (`record: true`), when its
// holder or a project writer turns it on (`POST /api/boxes/:id/recording`), or while a criterion's
// span needs it (`spans.ts`). The record says whether it records and why; the device says when it
// started and whether it could. One turned on here, or asked by the open, is sent to Forge once the
// box ends (`session.ts`, ISS-1338); a span's own is not.

import type { BoxReport } from '@forge/contracts/box-wire';
import type { BoxRecord, BoxRecordingWhy } from '@forge/contracts/boxes';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type BoxRow, boxes } from '../db/schema-boxes.js';
import { type BoxActor, pushBox, refuse, tellChanged } from './access.js';
import { boxById, boxRecord } from './read.js';
import { ownedRow } from './service.js';

/**
 * Start (`on`) or stop a running box's recording. A person turning it on records it as `person`, an
 * agent as `asked`; either keeps it past a span's end. One already in the state asked for moves
 * nothing on the device.
 */
export async function setBoxRecording(
  id: string,
  actor: BoxActor,
  on: boolean,
): Promise<BoxRecord> {
  const row = await ownedRow(id, actor, on ? "start a box's recording" : "stop a box's recording");
  if (row.state === 'closed' || row.state === 'failed') {
    throw refuse('BOX_CLOSED', `the box is ${row.state}: nothing records on it any more`);
  }
  if (row.state !== 'agent' && row.state !== 'person') {
    throw refuse('BOX_NOT_READY', `the box is ${row.state}: turn its recording on once it runs`);
  }
  const why: BoxRecordingWhy = actor.agency === 'human' ? 'person' : 'asked';
  const recording = row.recordingState === 'recording';
  if (!on && !recording) return boxRecord(row);
  await db.transaction(async (tx) => {
    const set = on
      ? { recordingState: 'recording' as const, recordingWhy: why, recordingAsked: true }
      : { recordingState: 'kept' as const, recordingWhy: null };
    const [moved] = await tx.update(boxes).set(set).where(eq(boxes.id, row.id)).returning();
    if (on !== recording) {
      await pushBox(tx, row.deviceId, 'box.recording.set', { boxId: row.id, on });
    }
    await tellChanged(tx, moved ?? row);
  });
  return boxRecord((await boxById(row.id)) ?? row);
}

/**
 * The device's word on a recording: when it started, or that it could not. A recording that could
 * not start records nothing, and the record keeps the tool's words.
 */
export async function recordingReport(
  row: BoxRow,
  report: Extract<BoxReport, { kind: 'recording' }>,
): Promise<void> {
  const set =
    report.state === 'on'
      ? { recordingStartedAt: new Date(report.at) }
      : report.state === 'failed'
        ? {
            recordingWhy: null,
            recordingState: row.recordingStartedAt ? ('kept' as const) : null,
            detail: `the recording did not ${row.recordingState === 'recording' ? 'run' : 'stop'}: ${report.detail ?? 'the device gave no words'}`,
          }
        : row.recordingWhy === null && row.recordingState === 'recording'
          ? { recordingState: 'kept' as const }
          : null;
  if (!set) return;
  await db.transaction(async (tx) => {
    const [moved] = await tx.update(boxes).set(set).where(eq(boxes.id, row.id)).returning();
    await tellChanged(tx, moved ?? row);
  });
}
