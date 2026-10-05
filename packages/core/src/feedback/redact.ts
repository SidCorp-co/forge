import { feedbackKey } from '@forge/contracts/feedback';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback, feedbackAttachments, feedbackDecisions } from '../db/schema-feedback.js';
import { getStorage } from '../integrations/index.js';
import { deleteFeedbackEmbedding } from '../knowledge/index.js';
import { logger } from '../lib/logger.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { deleteFeedbackQuestions } from '../questions/index.js';
import { feedbackDependents } from './dependents.js';
import { type FeedbackActor, rowIn } from './read.js';
import { redactActRefusal, redactedRefusal } from './rules.js';
import {
  answer,
  decide,
  type FeedbackOutcome,
  feedbackKernelActor,
  inTx,
  lockFeedback,
  roleFacts,
} from './service.js';

/**
 * UC15: a project admin person deletes what the reporter gave — the text, the attachments and
 * mockups with their bytes, the embedding, the clarification answers and the suggestion payloads
 * quoting it — and keeps the keyed row as a tombstone so every link to it still resolves.
 */
/** What stands in for a reporter's words once they are deleted; where_seen stays non-null for a screen item. */
const REDACTED = 'reporter data deleted';

export async function redactReporterData(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const forbidden = redactActRefusal(await roleFacts(actor, projectId));
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const first = await rowIn(db, projectId, input.ref);
  let paths: string[] = [];
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    const done = redactedRefusal(row.redactedAt);
    if (done) return [done];
    const gone = await tx
      .delete(feedbackAttachments)
      .where(eq(feedbackAttachments.feedbackId, row.id))
      .returning({ path: feedbackAttachments.storagePath });
    paths = gone.map((g) => g.path);
    await deleteFeedbackEmbedding(tx, row.id);
    await deleteFeedbackQuestions(tx, row.id);
    const now = new Date();
    const why = `reporter data of ${feedbackKey(row.fbSeq)} deleted`;
    await feedbackDependents().redactSuggestions(tx, row.id, {
      why,
      now,
      actor: feedbackKernelActor(actor),
    });
    await tx
      .update(feedbackDecisions)
      .set({ reason: REDACTED })
      .where(
        and(
          eq(feedbackDecisions.feedbackId, row.id),
          sql`${feedbackDecisions.reason} IS NOT NULL`,
          or(
            eq(feedbackDecisions.decidedBy, row.reportedBy),
            inArray(feedbackDecisions.decision, ['verified', 'reopened']),
          ),
        ),
      );
    await tx
      .update(feedback)
      .set({
        title: `${feedbackKey(row.fbSeq)} (${REDACTED})`,
        body: null,
        whereSeen: row.whereSeen === null ? null : REDACTED,
        redactedAt: now,
        redactedBy: actor.userId,
        updatedAt: now,
      })
      .where(eq(feedback.id, row.id));
    paths.push(...(await feedbackDependents().deleteMockups(tx, row.id)));
    await decide(tx, row, actor, { decision: 'redacted' });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  const storage = getStorage();
  for (const path of paths) {
    await storage.delete(path).catch((err: unknown) => {
      logger.error(
        { err, projectId, feedbackId: first.id, path },
        'feedback: a redacted attachment was not removed from storage',
      );
    });
  }
  return answer(projectId, first.id, actor);
}
