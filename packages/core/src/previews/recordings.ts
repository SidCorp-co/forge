// What a member did in a reproduce preview (REQ-41 BC-18, BC-21; docs/proposals/chat-first.md
// "Reproduce"): a recording starts when the relay serves a recording preview's page to a member,
// takes the recorder's batches in order, stores them scrubbed, and keeps a short timeline. It is
// read only by the project's members. Every move is RECORDING_MACHINE's, through the kernel.

import { gunzipSync, gzipSync } from 'node:zlib';
import type { ActorAgency } from '@forge/contracts/permissions';
import {
  RECORDING_LIMITS,
  RECORDING_MACHINE,
  type RecordingBatch,
  type RecordingRecord,
  type RecordingRefusalCode,
  type RecordingState,
  type RrwebEvent,
  recordingBatchSchema,
  type TimelineEntry,
  timelineOf,
} from '@forge/contracts/reproduce';
import { scrubPersonalData, scrubSecretsDeep } from '@forge/observability';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type PreviewRecordingRow, previewRecordings } from '../db/schema-preview-recordings.js';
import type { PreviewRow } from '../db/schema-previews.js';
import { getStorage } from '../integrations/index.js';
import { refuser } from '../lib/refusal.js';
import { type KernelActor, transition } from '../lifecycle/index.js';
import { actorFor, can, projectResource } from '../permissions/index.js';

export const refuseRecording = refuser<RecordingRefusalCode>('RECORDING_FORBIDDEN');

const SOURCE = 'previews.recordings';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the preview records its viewers: a reproduce that asked to (`subject.record`). */
export const records = (row: PreviewRow) =>
  row.subjectKind === 'reproduce' && row.subject?.kind === 'reproduce' && row.subject.record;

/**
 * The member's recording of this preview: the open one, or a new one when the relay first serves
 * them its page. One open recording per viewer and preview.
 */
export async function recordingFor(row: PreviewRow, userId: string): Promise<PreviewRecordingRow> {
  const open = async () =>
    (
      await db
        .select()
        .from(previewRecordings)
        .where(
          and(
            eq(previewRecordings.previewId, row.id),
            eq(previewRecordings.recordedBy, userId),
            eq(previewRecordings.state, 'recording'),
          ),
        )
        .limit(1)
    )[0];
  const held = await open();
  if (held) return held;
  if (row.subject?.kind !== 'reproduce' || row.feedbackId === null) {
    throw new Error(`previews: preview ${row.id} is not a reproduce and records nothing`);
  }
  const [inserted] = await db
    .insert(previewRecordings)
    .values({
      projectId: row.projectId,
      feedbackId: row.feedbackId,
      previewId: row.id,
      buildSha: row.subject.build.sha,
      buildRelease: row.subject.build.release,
      recordedBy: userId,
    })
    .onConflictDoNothing()
    .returning();
  const row2 = inserted ?? (await open());
  if (!row2) throw new Error(`previews: the recording of preview ${row.id} could not be opened`);
  return row2;
}

/** Every string in a batch, scrubbed of secrets and personal data before anything is stored. */
export function scrubEvents(events: readonly RrwebEvent[]): RrwebEvent[] {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v === '' ? v : scrubPersonalData(v).text;
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(scrubSecretsDeep(events)) as RrwebEvent[];
}

const nowIso = (d: Date | null) => (d === null ? null : d.toISOString());

export function recordingView(row: PreviewRecordingRow): RecordingRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    feedbackId: row.feedbackId,
    previewId: row.previewId,
    build: { sha: row.buildSha, release: row.buildRelease },
    state: row.state,
    reason: row.reason,
    recordedBy: row.recordedBy,
    startedAt: row.startedAt.toISOString(),
    stoppedAt: nowIso(row.stoppedAt),
    expiresAt: nowIso(row.expiresAt),
    events: row.events,
    bytes: row.bytes,
    timeline: row.timeline,
  };
}

async function move(
  row: PreviewRecordingRow,
  to: RecordingState,
  from: readonly RecordingState[],
  actor: KernelActor,
  set: Partial<PreviewRecordingRow>,
  reason?: string,
): Promise<PreviewRecordingRow | null> {
  const moved = await transition(db, RECORDING_MACHINE, {
    to,
    from,
    where: eq(previewRecordings.id, row.id),
    set,
    ...(reason === undefined ? {} : { reason }),
    actor,
    source: SOURCE,
  });
  return (moved.rows[0] as PreviewRecordingRow | undefined) ?? null;
}

const stopSet = (now: Date) => ({
  stoppedAt: now,
  expiresAt: new Date(now.getTime() + RECORDING_LIMITS.retentionDays * DAY_MS),
});

/** Where the timeline's `at` counts from, and the batch's entries placed on that clock. */
function placed(
  firstEventAt: number | null,
  events: readonly RrwebEvent[],
): { first: number; entries: TimelineEntry[] } {
  const start = Math.min(...events.map((e) => e.timestamp));
  const first = firstEventAt ?? start;
  const offset = Math.max(0, Math.round(start - first));
  return { first, entries: timelineOf(events).map((e) => ({ ...e, at: e.at + offset })) };
}

/**
 * One batch from the recorder (`POST /__forge_preview/rec`, behind the viewer cookie): the viewer's
 * own open recording of this preview, the next batch in order, within the limits. Its events are
 * scrubbed, kept gzip in the uploads store, and read into the timeline.
 */
export async function ingestBatch(
  preview: PreviewRow,
  userId: string,
  raw: Buffer,
  now = new Date(),
): Promise<{ recordingId: string; seq: number; timeline: number }> {
  if (raw.byteLength > RECORDING_LIMITS.batchBytes) {
    throw refuseRecording(
      'RECORDING_BATCH_TOO_LARGE',
      `a batch is at most ${RECORDING_LIMITS.batchBytes} bytes; this one is ${raw.byteLength}`,
    );
  }
  let batch: RecordingBatch;
  try {
    const parsed = recordingBatchSchema.safeParse(JSON.parse(raw.toString('utf8')));
    if (!parsed.success)
      throw new Error(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    batch = parsed.data;
  } catch (err) {
    throw refuseRecording(
      'RECORDING_BATCH_INVALID',
      `a batch is { recordingId, seq, events: 1..${RECORDING_LIMITS.batchEvents} rrweb events }: ${(err as Error).message}`,
    );
  }
  const [row] = await db
    .select()
    .from(previewRecordings)
    .where(
      and(
        eq(previewRecordings.id, batch.recordingId),
        eq(previewRecordings.previewId, preview.id),
        eq(previewRecordings.recordedBy, userId),
      ),
    )
    .limit(1);
  if (!row) {
    throw refuseRecording(
      'RECORDING_NOT_FOUND',
      `no recording ${batch.recordingId} of yours in this preview`,
    );
  }
  if (row.state !== 'recording') {
    throw refuseRecording(
      'RECORDING_CLOSED',
      `recording ${row.id} is ${row.state}: it takes no more batches`,
    );
  }
  const kernel: KernelActor = { type: 'sweeper' };
  if (now.getTime() - row.startedAt.getTime() > RECORDING_LIMITS.maxMinutes * 60_000) {
    await move(
      row,
      'stopped',
      ['recording'],
      kernel,
      stopSet(now),
      `reached ${RECORDING_LIMITS.maxMinutes} minutes`,
    );
    throw refuseRecording(
      'RECORDING_CLOSED',
      `recording ${row.id} reached ${RECORDING_LIMITS.maxMinutes} minutes and stopped`,
    );
  }
  if (batch.seq !== row.nextSeq) {
    throw refuseRecording(
      'RECORDING_SEQ_GAP',
      `recording ${row.id} owes batch ${row.nextSeq}, and this is ${batch.seq}: resend from ${row.nextSeq}`,
    );
  }
  const events = scrubEvents(batch.events);
  const gz = gzipSync(Buffer.from(JSON.stringify(events)));
  if (row.bytes + gz.byteLength > RECORDING_LIMITS.totalBytes) {
    await move(
      row,
      'failed',
      ['recording'],
      kernel,
      { ...stopSet(now), reason: 'RECORDING_TOO_LARGE' },
      'RECORDING_TOO_LARGE',
    );
    throw refuseRecording(
      'RECORDING_TOO_LARGE',
      `recording ${row.id} would pass ${RECORDING_LIMITS.totalBytes} bytes; what arrived before is kept`,
    );
  }
  const { path } = await getStorage().put(
    `recordings/${row.projectId}/${row.id}/${String(batch.seq).padStart(6, '0')}.json.gz`,
    gz,
    'application/gzip',
  );
  const { first, entries } = placed(row.firstEventAt, events);
  const timeline = [...row.timeline, ...entries].slice(0, RECORDING_LIMITS.timelineEntries);
  const updated = await db
    .update(previewRecordings)
    .set({
      nextSeq: row.nextSeq + 1,
      events: row.events + events.length,
      bytes: row.bytes + gz.byteLength,
      firstEventAt: first,
      segments: [...row.segments, path],
      timeline,
      lastBatchAt: now,
    })
    .where(
      and(
        eq(previewRecordings.id, row.id),
        eq(previewRecordings.nextSeq, batch.seq),
        eq(previewRecordings.state, 'recording'),
      ),
    )
    .returning({ id: previewRecordings.id });
  if (updated.length === 0) {
    await getStorage().delete(path);
    throw refuseRecording(
      'RECORDING_SEQ_GAP',
      `batch ${batch.seq} of recording ${row.id} arrived twice at once; resend from the next one owed`,
    );
  }
  return { recordingId: row.id, seq: batch.seq, timeline: timeline.length };
}

// ---- reads: members only (BC-21)

export interface RecordingReader {
  userId: string;
  agency: ActorAgency;
}

async function readable(row: PreviewRecordingRow | undefined, id: string, reader: RecordingReader) {
  if (!row) throw refuseRecording('RECORDING_NOT_FOUND', `no recording ${id}`);
  const member = await can(
    actorFor(reader.userId, reader.agency),
    'project.read',
    projectResource(row.projectId),
  );
  if (!member) {
    throw refuseRecording(
      'RECORDING_FORBIDDEN',
      'recordings open only for signed-in members of the project they were made in',
    );
  }
  return row;
}

export async function readRecording(id: string, reader: RecordingReader): Promise<RecordingRecord> {
  const [row] = await db
    .select()
    .from(previewRecordings)
    .where(eq(previewRecordings.id, id))
    .limit(1);
  return recordingView(await readable(row, id, reader));
}

/** A feedback item's recordings, newest first. */
export async function recordingsOfFeedback(
  projectId: string,
  feedbackKey: string,
  reader: RecordingReader,
): Promise<RecordingRecord[]> {
  const member = await can(
    actorFor(reader.userId, reader.agency),
    'project.read',
    projectResource(projectId),
  );
  if (!member) {
    throw refuseRecording(
      'RECORDING_FORBIDDEN',
      'recordings open only for signed-in members of the project',
    );
  }
  const m = /^FB-(\d{1,9})$/.exec(feedbackKey);
  const rows = m
    ? await db
        .select({ r: previewRecordings })
        .from(previewRecordings)
        .where(
          and(
            eq(previewRecordings.projectId, projectId),
            sql`${previewRecordings.feedbackId} = (SELECT id FROM feedback WHERE project_id = ${projectId}::uuid AND fb_seq = ${Number(m[1])})`,
          ),
        )
        .orderBy(desc(previewRecordings.startedAt))
    : [];
  return rows.map(({ r }) => recordingView(r));
}

/** The raw events, for replay in the feedback page, while within retention. */
export async function recordingEvents(id: string, reader: RecordingReader): Promise<RrwebEvent[]> {
  const [found] = await db
    .select()
    .from(previewRecordings)
    .where(eq(previewRecordings.id, id))
    .limit(1);
  const row = await readable(found, id, reader);
  if (row.state === 'redacted') {
    throw refuseRecording(
      'RECORDING_REDACTED',
      `recording ${id} was deleted with its reporter's data`,
    );
  }
  if (row.state === 'expired') {
    throw refuseRecording(
      'RECORDING_EXPIRED',
      `recording ${id}'s events were deleted after ${RECORDING_LIMITS.retentionDays} days; its timeline is still read`,
    );
  }
  const storage = getStorage();
  const out: RrwebEvent[] = [];
  for (const path of row.segments) {
    out.push(...(JSON.parse(gunzipSync(await storage.get(path)).toString('utf8')) as RrwebEvent[]));
  }
  return out;
}

/** The viewer stops their own recording; anyone else who may write on the project may too. */
export async function stopRecording(id: string, reader: RecordingReader): Promise<RecordingRecord> {
  const [found] = await db
    .select()
    .from(previewRecordings)
    .where(eq(previewRecordings.id, id))
    .limit(1);
  const row = await readable(found, id, reader);
  if (row.recordedBy !== reader.userId) {
    const writer = await can(
      actorFor(reader.userId, reader.agency),
      'project.write',
      projectResource(row.projectId),
    );
    if (!writer) {
      throw refuseRecording(
        'RECORDING_FORBIDDEN',
        'only the member it records, or one who may write on the project, stops a recording',
      );
    }
  }
  if (row.state !== 'recording') {
    throw refuseRecording('RECORDING_CLOSED', `recording ${id} is ${row.state} already`);
  }
  const moved = await move(
    row,
    'stopped',
    ['recording'],
    { type: 'user', id: reader.userId, agency: reader.agency },
    stopSet(new Date()),
    'stopped by its viewer',
  );
  return recordingView(moved ?? row);
}

// ---- sweep and redaction

/**
 * The recordings' sweep (with the preview sweep): one that got no batch within `firstBatchSeconds`
 * of its first page fails RECORDER_BLOCKED; one past `maxMinutes`, or whose preview stopped serving,
 * stops; a stopped one past retention expires and its events are deleted, its timeline kept.
 */
export async function sweepRecordings(now = new Date()): Promise<number> {
  const kernel: KernelActor = { type: 'sweeper' };
  let moved = 0;
  const blocked = await db
    .select()
    .from(previewRecordings)
    .where(
      and(
        eq(previewRecordings.state, 'recording'),
        isNull(previewRecordings.lastBatchAt),
        lt(
          previewRecordings.startedAt,
          new Date(now.getTime() - RECORDING_LIMITS.firstBatchSeconds * 1000),
        ),
      ),
    );
  for (const row of blocked) {
    const done = await move(
      row,
      'failed',
      ['recording'],
      kernel,
      { ...stopSet(now), reason: 'RECORDER_BLOCKED' },
      'RECORDER_BLOCKED',
    );
    if (done) moved++;
  }
  const ending = (await db.execute(sql`
    SELECT r.id FROM preview_recordings r JOIN previews p ON p.id = r.preview_id
     WHERE r.state = 'recording'
       AND (r.started_at < ${new Date(now.getTime() - RECORDING_LIMITS.maxMinutes * 60_000).toISOString()}::timestamptz
            OR p.state NOT IN ('starting', 'live'))
  `)) as unknown as { id: string }[];
  if (ending.length > 0) {
    const rows = await db
      .select()
      .from(previewRecordings)
      .where(
        inArray(
          previewRecordings.id,
          ending.map((e) => e.id),
        ),
      );
    for (const row of rows) {
      if (
        await move(
          row,
          'stopped',
          ['recording'],
          kernel,
          stopSet(now),
          'its preview closed or it reached its length',
        )
      )
        moved++;
    }
  }
  const expired = await db
    .select()
    .from(previewRecordings)
    .where(and(eq(previewRecordings.state, 'stopped'), lt(previewRecordings.expiresAt, now)));
  for (const row of expired) {
    if (await move(row, 'expired', ['stopped'], kernel, { segments: [] }, 'past retention')) {
      for (const path of row.segments) await getStorage().delete(path);
      moved++;
    }
  }
  return moved;
}

/**
 * A feedback item's recordings deleted with its reporter's data (`feedback.redact`): events and
 * timeline. The feedback module's redaction calls this through its dependents port.
 */
export async function redactRecordingsOf(feedbackId: string, actor: KernelActor): Promise<number> {
  const rows = await db
    .select()
    .from(previewRecordings)
    .where(
      and(
        eq(previewRecordings.feedbackId, feedbackId),
        inArray(previewRecordings.state, ['recording', 'stopped', 'expired']),
      ),
    );
  let n = 0;
  for (const row of rows) {
    const done = await move(
      row,
      'redacted',
      ['recording', 'stopped', 'expired'],
      actor,
      { segments: [], timeline: [], stoppedAt: row.stoppedAt ?? new Date() },
      'its reporter data was deleted',
    );
    if (done) {
      for (const path of row.segments) await getStorage().delete(path);
      n++;
    }
  }
  return n;
}
