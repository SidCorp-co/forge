// A criterion's span on a box's recording becomes its evidence (ISS-1276, ADR 0015). The agent marks
// where the demonstration starts and ends; the device answers each mark with the recording offset it
// landed at; core then orders the clip cut within the release page's ceiling, and attaches the clip
// and its opening still to the issue, under the criterion. A verdict cites them as it cites a clip a
// judge recorded by hand (`issues/criteria/clip-citation.ts:clipFault`), and a release page shows them.

import type { BoxSpanRecord } from '@forge/contracts/boxes';
import { RELEASE_CLIP_MAX_BYTES, RELEASE_CLIP_MAX_SECONDS } from '@forge/contracts/release-page';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type BoxRow, type BoxSpanRow, boxSpans } from '../db/schema-boxes.js';
import { persistIssueAttachment } from '../issues/index.js';
import { accessFor, type BoxActor, pushBox, refuse, tellChanged } from './access.js';
import { spanRecord } from './read.js';
import { rowOf } from './service.js';

/** Mark where criterion `criterion`'s demonstration starts or ends on the box's recording. */
export async function markSpan(
  actor: BoxActor,
  boxId: string,
  criterion: number,
  edge: 'start' | 'end',
): Promise<BoxSpanRecord> {
  const row = await rowOf(boxId);
  if (row.projectId === null) throw refuse('BOX_NOT_FOUND', `no box ${boxId} is any project's`);
  await accessFor(row.projectId, actor, 'project.write', 'mark a span on a box');
  if (row.issueId === null) {
    throw refuse(
      'BOX_SPAN_INVALID',
      'this box holds no issue, so a span has no criterion to be evidence for: open the box with the issue it tests',
      '/criterion',
    );
  }
  if (row.state !== 'agent' && row.state !== 'person') {
    throw refuse('BOX_NOT_READY', `the box is ${row.state}: mark a span while it runs`);
  }
  const issueId = row.issueId;
  return db.transaction(async (tx) => {
    const [open] = await tx
      .select()
      .from(boxSpans)
      .where(
        and(
          eq(boxSpans.boxId, row.id),
          eq(boxSpans.criterion, criterion),
          eq(boxSpans.state, 'open'),
        ),
      )
      .for('update')
      .limit(1);
    if (edge === 'start') {
      if (open) {
        throw refuse(
          'BOX_SPAN_INVALID',
          `criterion ${criterion}'s span on this box is already open since ${open.startedAt.toISOString()}: end it first`,
          '/edge',
        );
      }
      const [span] = await tx
        .insert(boxSpans)
        .values({ boxId: row.id, issueId, criterion, createdBy: actor.userId })
        .returning();
      if (!span) throw new Error('box_spans: insert returned no row');
      await pushBox(tx, row.deviceId, 'box.span.mark', {
        boxId: row.id,
        spanId: span.id,
        criterion,
        edge,
      });
      await tellChanged(tx, row);
      return spanRecord(span);
    }
    if (!open) {
      throw refuse(
        'BOX_SPAN_INVALID',
        `criterion ${criterion} has no open span on this box: mark its start first`,
        '/edge',
      );
    }
    const [span] = await tx
      .update(boxSpans)
      .set({ state: 'cutting', endedAt: new Date() })
      .where(eq(boxSpans.id, open.id))
      .returning();
    await pushBox(tx, row.deviceId, 'box.span.mark', {
      boxId: row.id,
      spanId: open.id,
      criterion,
      edge,
    });
    await tellChanged(tx, row);
    return spanRecord(span ?? open);
  });
}

/**
 * The device's `mark` report: the offset a mark landed at. Once both ends are known, the cut is
 * ordered: a span longer than the ceiling keeps its last `RELEASE_CLIP_MAX_SECONDS`, where the
 * criterion was shown.
 */
export async function recordMark(
  row: BoxRow,
  report: { spanId: string; edge: 'start' | 'end'; offsetMs: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [span] = await tx
      .update(boxSpans)
      .set(
        report.edge === 'start'
          ? { startOffsetMs: report.offsetMs }
          : { endOffsetMs: report.offsetMs },
      )
      .where(and(eq(boxSpans.id, report.spanId), eq(boxSpans.boxId, row.id)))
      .returning();
    if (!span) throw refuse('BOX_SPAN_INVALID', `no span ${report.spanId} on box ${row.id}`);
    if (span.state !== 'cutting' || span.startOffsetMs === null || span.endOffsetMs === null)
      return;
    const toMs = Math.max(span.endOffsetMs, span.startOffsetMs + 1);
    const fromMs = Math.max(span.startOffsetMs, toMs - RELEASE_CLIP_MAX_SECONDS * 1000);
    await pushBox(tx, row.deviceId, 'box.recording.fetch', {
      boxId: row.id,
      spanId: span.id,
      fromMs,
      toMs,
      maxSeconds: RELEASE_CLIP_MAX_SECONDS,
      maxBytes: RELEASE_CLIP_MAX_BYTES,
    });
  });
}

async function spanOf(row: BoxRow, spanId: string): Promise<BoxSpanRow> {
  const [span] = await db
    .select()
    .from(boxSpans)
    .where(and(eq(boxSpans.id, spanId), eq(boxSpans.boxId, row.id)))
    .limit(1);
  if (!span) throw refuse('BOX_SPAN_INVALID', `no span ${spanId} on box ${row.id}`);
  return span;
}

export async function failSpan(row: BoxRow, spanId: string, detail: string): Promise<void> {
  const span = await spanOf(row, spanId);
  await db
    .update(boxSpans)
    .set({ state: 'failed', detail: detail.slice(-4000) })
    .where(eq(boxSpans.id, span.id));
}

const CLIP_MIMES: Record<string, string> = { 'video/webm': 'webm', 'video/mp4': 'mp4' };

/**
 * The device's cut, uploaded: the clip and its opening still become attachments of the issue, named
 * for the box and the criterion, and the span records them. A clip past the ceiling is refused by
 * name and the span fails, so nothing over what a release page shows is ever attached.
 */
export async function attachSpanClip(
  deviceId: string,
  boxId: string,
  spanId: string,
  clip: { bytes: Buffer; mime: string },
  still: { bytes: Buffer; mime: string },
): Promise<BoxSpanRecord> {
  const row = await rowOf(boxId);
  if (row.deviceId !== deviceId)
    throw refuse('BOX_NOT_FOUND', `no box ${boxId} is held by this device`);
  const span = await spanOf(row, spanId);
  if (span.state === 'attached') return spanRecord(span);
  const ext = CLIP_MIMES[clip.mime];
  if (!ext) {
    await failSpan(row, spanId, `the clip is ${clip.mime}; a box clip is video/webm or video/mp4`);
    throw refuse(
      'BOX_SPAN_INVALID',
      `a box clip is video/webm or video/mp4, not ${clip.mime}`,
      '/clip',
    );
  }
  if (clip.bytes.byteLength > RELEASE_CLIP_MAX_BYTES) {
    const detail = `the clip is ${clip.bytes.byteLength} bytes, over the ${RELEASE_CLIP_MAX_BYTES} a release page shows`;
    await failSpan(row, spanId, detail);
    throw refuse('BOX_SPAN_INVALID', detail, '/clip');
  }
  const base = `box-${row.id.slice(0, 8)}-c${span.criterion}-${span.id.slice(0, 8)}`;
  const common = {
    issueId: span.issueId,
    uploaderId: span.createdBy,
    uploaderAgency: 'agent' as const,
  };
  const clipFile = await persistIssueAttachment({
    ...common,
    name: `${base}.${ext}`,
    mime: clip.mime,
    bytes: clip.bytes,
  });
  const stillFile = await persistIssueAttachment({
    ...common,
    name: `${base}.png`,
    mime: still.mime,
    bytes: still.bytes,
  });
  const [attached] = await db.transaction(async (tx) => {
    const out = await tx
      .update(boxSpans)
      .set({
        state: 'attached',
        clipAttachmentId: clipFile.id,
        stillAttachmentId: stillFile.id,
        detail: null,
      })
      .where(eq(boxSpans.id, span.id))
      .returning();
    await tellChanged(tx, row);
    return out;
  });
  return spanRecord(attached ?? span);
}
