// The reporter's word on a fix preview (REQ-41 BC-20; docs/proposals/chat-first.md "Confirm"): the
// preview of an issue a feedback item routes to, confirmed fixed or not fixed by whoever reported
// it or anyone on the project for them, bound to the patch id the preview served at that moment.
// The feedback item's loop close reads the latest word (`loopCloseFromConfirm`) when the issue
// ships; this module records it and answers it, and writes nothing on the feedback item.

import type { ConfirmFixRequest } from '@forge/contracts/preview';
import type { FixConfirmation } from '@forge/contracts/reproduce';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type PreviewFixConfirmationRow,
  previewFixConfirmations,
} from '../db/schema-preview-recordings.js';
import { accessFor, type PreviewActor, refuse, rowOf, throwRefusal } from './access.js';
import { askSnapshot } from './approve.js';
import { stateRefusal } from './rules.js';
import { feedbackRoutedTo } from './subject-reads.js';

const view = (row: PreviewFixConfirmationRow): FixConfirmation => ({
  feedbackId: row.feedbackId,
  previewId: row.previewId,
  patchId: row.patchId,
  verdict: row.verdict,
  note: row.note,
  by: row.by,
  at: row.at.toISOString(),
});

/**
 * Record whether the fix preview fixes it, for each feedback item routed to the preview's issue.
 * The box reads the patch id it serves now; a preview that does not serve is refused, since a word
 * on nothing seen binds to nothing. Needs `project.read`: the reporter may be any member.
 */
export async function confirmFix(
  previewId: string,
  actor: PreviewActor,
  request: ConfirmFixRequest,
): Promise<FixConfirmation[]> {
  const row = await rowOf(previewId);
  await accessFor(row.projectId, actor, 'project.read', 'confirm a fix');
  if (row.subjectKind !== 'issue' || row.issueId === null) {
    throw refuse(
      'PREVIEW_CONFIRM_NOT_FIX',
      `preview ${row.id} serves ${row.subjectKind === 'idea' ? 'an idea' : 'a past build'}, not the fix of an issue: a fix is confirmed on the preview of the issue a feedback item routes to`,
    );
  }
  const items = await feedbackRoutedTo(row.issueId);
  if (items.length === 0) {
    throw refuse(
      'PREVIEW_CONFIRM_NOT_FIX',
      `no feedback item routes to the issue preview ${row.id} serves, so it fixes nothing anyone reported: confirm on the preview of an issue a feedback item routes to`,
    );
  }
  if (request.verdict === 'not_fixed' && !request.note?.trim()) {
    throw refuse(
      'PREVIEW_CONFIRM_REASON_REQUIRED',
      'not fixed says what is still wrong: send a note',
      '/note',
    );
  }
  throwRefusal(stateRefusal(row.id, row.state, ['live'], 'be confirmed'));
  const snapshot = await askSnapshot(row);
  const note = request.note?.trim() || null;
  const written = await db
    .insert(previewFixConfirmations)
    .values(
      items.map((item) => ({
        projectId: row.projectId,
        feedbackId: item.id,
        previewId: row.id,
        patchId: snapshot.patchId,
        verdict: request.verdict,
        note,
        by: actor.userId,
      })),
    )
    .returning();
  return written.map(view);
}

/** A feedback item's confirms, newest first: what its loop close reads when the fix ships. */
export async function fixConfirmationsOf(feedbackId: string): Promise<FixConfirmation[]> {
  const rows = await db
    .select()
    .from(previewFixConfirmations)
    .where(eq(previewFixConfirmations.feedbackId, feedbackId))
    .orderBy(desc(previewFixConfirmations.at));
  return rows.map(view);
}
