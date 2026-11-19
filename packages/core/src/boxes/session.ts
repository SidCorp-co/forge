// A box's kept whole-session recording, brought to Forge once the box ends (ISS-1338, FB-747). A
// recording stays on its device while the box runs; when a box whose recording a person or the open
// asked for closes or fails, its device is told to send the whole of it through the span clip's own
// upload (`BOX_ROUTES.clip`, `session` in the span's place), within `BOX_LIMITS.sessionMaxBytes`, and
// it becomes an attachment of the box's issue beside the span clips. Where it cannot come, the
// record says why (`BOX_SESSION_FAULTS`). Recording stays optional (owner 2026-11-18): a box nobody
// asked to record, or one only a span recorded, sends nothing.

import type { BoxReport } from '@forge/contracts/box-wire';
import { BOX_LIMITS, type BoxRecord, type BoxSessionFault } from '@forge/contracts/boxes';
import { and, eq, lt, or } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type BoxRow, boxes } from '../db/schema-boxes.js';
import { boxDeviceOf } from '../devices/index.js';
import { pushBox, refuse, tellChanged } from './access.js';
import { boxById, boxRecord } from './read.js';
import { CLIP_MIMES, persistClip } from './spans.js';

type SessionSet = Pick<
  Partial<BoxRow>,
  'sessionState' | 'sessionAt' | 'sessionFault' | 'sessionDetail'
>;

/**
 * What a box's end owes its recording, written with the end's own move: a kept recording a person
 * or the open asked for is `sending`, and `send` says the device is told after its `box.close`;
 * with no issue to hold it, it fails `NO_ISSUE` at once. Anything else owes nothing.
 */
export function sessionAtEnd(row: BoxRow, now = new Date()): { set: SessionSet; send: boolean } {
  const kept = row.recordingState === 'recording' || row.recordingState === 'kept';
  if (!row.recordingAsked || !kept || row.sessionState !== null) return { set: {}, send: false };
  if (row.issueId === null) {
    return {
      set: {
        sessionState: 'failed',
        sessionAt: now,
        sessionFault: 'NO_ISSUE',
        sessionDetail:
          'this box tests no issue, so nothing holds its recording in Forge: it stays on the device',
      },
      send: false,
    };
  }
  return { set: { sessionState: 'sending', sessionAt: now }, send: true };
}

/** The device sends the kept recording; pushed after the end's `box.close`, in its transaction. */
export async function sendSession(tx: Tx, row: Pick<BoxRow, 'id' | 'deviceId'>): Promise<void> {
  await pushBox(tx, row.deviceId, 'box.recording.upload', {
    boxId: row.id,
    maxBytes: BOX_LIMITS.sessionMaxBytes,
  });
}

/**
 * The recording could not come. The first fault stands: a refusal core already recorded is not
 * overwritten by the device's word on it, but the device's word replaces core's `NO_ANSWER`.
 */
export async function failSession(
  row: BoxRow,
  fault: BoxSessionFault,
  detail: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [moved] = await tx
      .update(boxes)
      .set({
        sessionState: 'failed',
        sessionAt: new Date(),
        sessionFault: fault,
        sessionDetail: detail.slice(-4000),
      })
      .where(
        and(
          eq(boxes.id, row.id),
          or(eq(boxes.sessionState, 'sending'), eq(boxes.sessionFault, 'NO_ANSWER')),
        ),
      )
      .returning();
    if (moved) await tellChanged(tx, moved);
  });
}

/** The device's `session_failed` report. */
export async function sessionReport(
  row: BoxRow,
  report: Extract<BoxReport, { kind: 'session_failed' }>,
): Promise<void> {
  await failSession(row, report.fault, report.detail);
}

/**
 * The device's upload of the whole kept recording: the clip and its opening still become
 * attachments of the box's issue, named for the box, and the record names them. A box that owes
 * none is refused `BOX_SESSION_NOT_OWED`, so nothing nobody asked for is ever attached; a clip past
 * `BOX_LIMITS.sessionMaxBytes` is refused and the record says `TOO_LARGE`.
 */
export async function attachSession(
  deviceId: string,
  boxId: string,
  clip: { bytes: Buffer; mime: string },
  still: { bytes: Buffer; mime: string },
): Promise<BoxRecord> {
  const row = await boxById(boxId);
  if (!row || row.deviceId !== deviceId) {
    throw refuse('BOX_NOT_FOUND', `no box ${boxId} is held by this device`);
  }
  if (row.sessionState === 'attached') return boxRecord(row);
  if (row.sessionState === null || row.issueId === null) {
    throw refuse(
      'BOX_SESSION_NOT_OWED',
      row.recordingAsked && row.state !== 'closed' && row.state !== 'failed'
        ? `box ${boxId} has not ended: its recording is sent once it closes`
        : `nobody asked for box ${boxId}'s recording, so none is sent to Forge: recording is optional`,
      '/spanId',
    );
  }
  const ext = CLIP_MIMES[clip.mime];
  if (!ext) {
    const detail = `the recording is ${clip.mime}; a box clip is video/webm or video/mp4`;
    await failSession(row, 'SEND_FAILED', detail);
    throw refuse('BOX_SPAN_INVALID', detail, '/clip');
  }
  if (clip.bytes.byteLength > BOX_LIMITS.sessionMaxBytes) {
    const detail = `the recording is ${clip.bytes.byteLength} bytes, over the ${BOX_LIMITS.sessionMaxBytes} a box sends to Forge`;
    await failSession(row, 'TOO_LARGE', detail);
    throw refuse('BOX_SPAN_INVALID', detail, '/clip');
  }
  const base = `box-${row.id.slice(0, 8)}-session`;
  const owner = {
    issueId: row.issueId,
    uploaderId: row.createdBy,
    uploaderAgency: row.openedAs === 'person' ? ('human' as const) : ('agent' as const),
  };
  const { clipFile, stillFile } = await persistClip(owner, base, ext, clip, still);
  const attached = await db.transaction(async (tx) => {
    const [moved] = await tx
      .update(boxes)
      .set({
        sessionState: 'attached',
        sessionAt: new Date(),
        sessionClipId: clipFile.id,
        sessionStillId: stillFile.id,
        sessionFault: null,
        sessionDetail: null,
      })
      .where(eq(boxes.id, row.id))
      .returning();
    await tellChanged(tx, moved ?? row);
    return moved;
  });
  return boxRecord(attached ?? row);
}

/**
 * The sweep: a recording the device was told to send and has not answered for
 * `BOX_LIMITS.sessionAnswerSeconds` fails `DEVICE_GONE` where its device is offline, else `NO_ANSWER`.
 */
export async function sweepSessions(now: Date): Promise<number> {
  const before = new Date(now.getTime() - BOX_LIMITS.sessionAnswerSeconds * 1000);
  const silent = await db
    .select()
    .from(boxes)
    .where(and(eq(boxes.sessionState, 'sending'), lt(boxes.sessionAt, before)))
    .limit(200);
  for (const row of silent) {
    const online = (await boxDeviceOf(row.deviceId))?.online === true;
    await failSession(
      row,
      online ? 'NO_ANSWER' : 'DEVICE_GONE',
      online
        ? `the device said nothing of the recording within ${BOX_LIMITS.sessionAnswerSeconds}s of being told to send it`
        : 'the device went offline before it sent the recording',
    );
  }
  return silent.length;
}
