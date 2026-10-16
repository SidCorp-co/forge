/**
 * `item_embeddings` for feedback (Q7): one vector per item, of its stored head text (title and
 * body, already scrubbed on a sensitive project), written after the item is filed through the
 * shared writer, which withholds it on a no_egress project. "Similar feedback" compares the item's
 * own stored vector with its project's, so reading it sends nothing to a provider.
 */

import {
  type FeedbackDedup,
  feedbackKey,
  type SimilarFeedbackDraft,
  type SimilarFeedbackResponse,
} from '@forge/contracts/feedback';
import { say, sayEn } from '@forge/contracts/said';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import {
  embedText,
  itemEmbeddingOf,
  type NearestItem,
  nearestItems,
  writeItemEmbedding,
} from '../knowledge/index.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { feedbackEgress, type ReadDoor } from './egress.js';
import { phaseOfRow } from './list-read.js';
import { type FeedbackActor, rowIn } from './read.js';

/** Embeds the item's text, replacing whatever row it held; a redacted item holds none. */
export async function embedFeedback(feedbackId: string) {
  const [row] = await db.select().from(feedback).where(eq(feedback.id, feedbackId));
  if (!row || row.redactedAt) return null;
  return writeItemEmbedding({
    projectId: row.projectId,
    arc: { feedbackId },
    version: 1,
    text: [row.title, row.body ?? ''].filter((s) => s.trim()).join('\n'),
    what: feedbackKey(row.fbSeq),
  });
}

/** After the write committed: embed, logging what did not land. */
export function embedFeedbackLater(feedbackId: string): void {
  embedFeedback(feedbackId)
    .then((status) => {
      if (status && status !== 'embedded') {
        logger.warn({ feedbackId, status }, 'item_embeddings: the feedback item was not embedded');
      }
    })
    .catch((err: unknown) =>
      logger.error(
        { err, feedbackId },
        'item_embeddings: the feedback embedding row was not written',
      ),
    );
}

/** The nearest other item by stored vector, keys only, or why it could not be compared. */
export async function nearestFeedbackOf(
  projectId: string,
  feedbackId: string,
): Promise<FeedbackDedup> {
  const own = await itemEmbeddingOf({ feedbackId });
  if (own?.status !== 'embedded' || !own.embedding || !own.model) {
    const why = own
      ? say('feedback.notice.noDedup', { status: own.status })
      : say('feedback.notice.noDedupUnwritten');
    return { ran: false, nearest: null, why: sayEn(why), says: { why } };
  }
  const [near] = await nearestItems({
    projectId,
    kind: 'feedback',
    vector: own.embedding,
    model: own.model,
    exclude: feedbackId,
    limit: 1,
  });
  const [hit] = near
    ? await db.select({ seq: feedback.fbSeq }).from(feedback).where(eq(feedback.id, near.itemId))
    : [];
  if (!near || !hit) return { ran: true, nearest: null };
  return { ran: true, nearest: feedbackKey(hit.seq), similarity: near.similarity };
}

/** The items `nearest` names, as a viewer may read them, nearest first. */
async function hitsOf(
  projectId: string,
  nearest: readonly NearestItem[],
  withhold: boolean,
): Promise<SimilarFeedbackResponse['hits']> {
  const rows =
    nearest.length === 0
      ? []
      : await db
          .select()
          .from(feedback)
          .where(
            inArray(
              feedback.id,
              nearest.map((n) => n.itemId),
            ),
          );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Promise.all(
    nearest.flatMap((n) => {
      const item = byId.get(n.itemId);
      if (!item) return [];
      return [
        (async () => ({
          key: feedbackKey(item.fbSeq),
          title: withhold ? feedbackKey(item.fbSeq) : item.title,
          phase: await phaseOfRow(projectId, item),
          similarity: n.similarity,
        }))(),
      ];
    }),
  );
}

export async function similarFeedbackAs(
  viewer: FeedbackActor,
  projectId: string,
  ref: string,
  door: ReadDoor = {},
  limit = 5,
): Promise<SimilarFeedbackResponse> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const { withhold, shown } = feedbackEgress(await dataPolicyOf(projectId), viewer.agency, door);
  const row = await rowIn(db, projectId, ref);
  const own = await itemEmbeddingOf({ feedbackId: row.id });
  if (own?.status !== 'embedded' || !own.embedding || !own.model) {
    // The item's own row status is answered as it is: withheld_by_policy (a no_egress
    // project), provider_not_configured or failed each say why, and only a missing row reads not_embedded
    const status = own && own.status !== 'embedded' ? own.status : 'not_embedded';
    return {
      status,
      message:
        own?.error ??
        `${feedbackKey(row.fbSeq)} has no vector yet, so nothing is compared; it does not mean none is similar.`,
      hits: [],
    };
  }
  const nearest = await nearestItems({
    projectId,
    kind: 'feedback',
    vector: own.embedding,
    model: own.model,
    exclude: row.id,
    limit,
  });
  const hits = await hitsOf(projectId, nearest, withhold);
  return { status: 'ok', model: own.model, hits: shown(hits, 'the similar feedback') };
}

/**
 * The filed items most like a draft not yet sent: the draft's head embedded through the same policy
 * gate an item's own vector passes, compared with the project's stored vectors, nothing written. A
 * draft the policy withholds, or no provider can embed, answers that status and no hits, never an
 * empty list that would read as "nothing similar".
 */
export async function similarToDraftAs(
  viewer: FeedbackActor,
  projectId: string,
  draft: SimilarFeedbackDraft,
  door: ReadDoor = {},
  limit = 5,
): Promise<SimilarFeedbackResponse> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const { withhold, shown } = feedbackEgress(await dataPolicyOf(projectId), viewer.agency, door);
  const text = [draft.title, draft.body ?? ''].filter((t) => t.trim()).join('\n');
  const own = await embedText(projectId, 'feedback', text, 'the feedback draft');
  if (own.status !== 'embedded') return { status: own.status, message: own.error, hits: [] };
  const nearest = await nearestItems({
    projectId,
    kind: 'feedback',
    vector: own.vector,
    model: own.model,
    limit,
  });
  const hits = await hitsOf(projectId, nearest, withhold);
  return { status: 'ok', model: own.model, hits: shown(hits, 'the similar feedback') };
}
