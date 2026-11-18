/**
 * One attachment deleted from a feedback item, with its bytes (ISS-1327). The only deletion an item
 * had was its reporter's whole data (`redact.ts`, UC15), so the one picture showing a secret key on
 * adminhub-fe FB-29 could not go without the item's text and every other picture going with it. Here
 * one attachment goes by its id, the item's other attachments and text stay, and why is written on
 * the item's record as an internal note naming the file, never its bytes. Its writer deletes it, as
 * does anyone holding `feedback.redact`; an id the item does not hold, an empty reason and an item
 * whose reporter data is already deleted are refused by name, and nothing is deleted.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedbackAttachments, feedbackMessages } from '../db/schema-feedback.js';
import { getStorage } from '../integrations/index.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import type { Refusal } from '../lib/refusal.js';
import { writtenLangFor } from '../lib/written-lang.js';
import { requireDeclaredOn } from '../permissions/index.js';
import { type FeedbackActor, rowIn } from './read.js';
import { redactActRefusal, redactedRefusal } from './rules.js';
import { answer, type FeedbackOutcome, inTx, lockFeedback, roleFacts } from './service.js';

export async function deleteAttachment(input: {
  projectId: string;
  ref: string;
  attachmentId: string;
  reason: string;
  actor: FeedbackActor;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await requireDeclaredOn(projectId, actor.userId, 'project.read');
  const why = input.reason.trim();
  if (!why) {
    return {
      ok: false,
      refusals: [
        {
          code: 'FEEDBACK_ATTACHMENT_REASON_REQUIRED',
          path: '/reason',
          detail:
            "say why this attachment is deleted: it is written on the item's record. Nothing was deleted.",
        },
      ],
    };
  }
  const first = await rowIn(db, projectId, input.ref);
  // the item's writer deletes what it attached; anyone else holds feedback.redact (project admin)
  const forbidden =
    first.reportedBy === actor.userId ? null : redactActRefusal(await roleFacts(actor, projectId));
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const held: { path: string | null } = { path: null };
  const refusals = await inTx(async (tx): Promise<Refusal[] | null> => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    const done = redactedRefusal(row.redactedAt);
    if (done) return [done];
    const [gone] = await tx
      .delete(feedbackAttachments)
      .where(
        and(
          eq(feedbackAttachments.id, input.attachmentId),
          eq(feedbackAttachments.feedbackId, row.id),
        ),
      )
      .returning({ name: feedbackAttachments.name, path: feedbackAttachments.storagePath });
    if (!gone) {
      return [
        {
          code: 'FEEDBACK_ATTACHMENT_UNKNOWN',
          path: '/attachment',
          detail: `${feedbackKey(row.fbSeq)} holds no attachment ${input.attachmentId}; its attachments are listed on the item. Nothing was deleted.`,
        },
      ];
    }
    held.path = gone.path;
    const note = storedText(
      await dataPolicyOf(projectId),
      `Attachment "${gone.name}" (${input.attachmentId}) deleted: ${why}`,
    ).text;
    await tx.insert(feedbackMessages).values({
      projectId,
      feedbackId: row.id,
      audience: 'internal',
      body: note,
      recipients: [],
      sentBy: actor.userId,
      sentAgency: actor.agency,
      writtenLang: await writtenLangFor(actor, projectId, undefined, tx, why),
    });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  const stored = held.path;
  if (stored) {
    await getStorage()
      .delete(stored)
      .catch((err: unknown) => {
        logger.error(
          { err, projectId, feedbackId: first.id, path: stored },
          'feedback: a deleted attachment was not removed from storage',
        );
      });
  }
  return answer(projectId, first.id, actor);
}
