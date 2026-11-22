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
import { activeIssuePrefix } from '../issues/index.js';
import {
  embedText,
  itemEmbeddingOf,
  type NearestItem,
  nearestItems,
  writeItemEmbedding,
} from '../knowledge/index.js';
import { background } from '../lib/background.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import { requireDeclaredOn } from '../permissions/index.js';
import { feedbackEgress, type ReadDoor } from './egress.js';
import { rootRowsOf } from './linked-rows.js';
import { carrierIssueRows } from './list-carriers.js';
import { phaseOfRow } from './list-read.js';
import { type FeedbackActor, type Row, rowIn } from './read.js';
import { routeIssuesOf } from './relations.js';

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
const embeddings = background();

export function embedFeedbackLater(feedbackId: string): void {
  embeddings.start(
    async () => {
      const status = await embedFeedback(feedbackId);
      if (status && status !== 'embedded') {
        logger.warn({ feedbackId, status }, 'item_embeddings: the feedback item was not embedded');
      }
    },
    (err: unknown) =>
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
  const routing = await routingOf(projectId, rows);
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
          ...routing(item),
        }))(),
      ];
    }),
  );
}

/**
 * Where a duplicate of each hit would route (ISS-1402): the hit's root, where the hit is itself a
 * duplicate, and the issues carrying the root's route, so a triage names the root and its carrier
 * from this one read, never the nearest hit `FEEDBACK_DUPLICATE_CHAIN` then refuses
 * (`verb-rules.ts:duplicateRefusal`). A root is one hop away: a duplicate never names a duplicate.
 */
async function routingOf(
  projectId: string,
  hits: readonly Row[],
): Promise<(hit: Row) => { duplicateOf: string | null; carriers: string[] }> {
  const byId = new Map(hits.map((r) => [r.id, r]));
  const unread = [
    ...new Set(
      hits.flatMap((r) => (r.duplicateOf && !byId.has(r.duplicateOf) ? [r.duplicateOf] : [])),
    ),
  ];
  for (const root of await rootRowsOf(unread)) byId.set(root.id, root);
  const rootOf = (hit: Row): Row => {
    if (!hit.duplicateOf) return hit;
    const root = byId.get(hit.duplicateOf);
    if (!root) {
      throw new Error(
        `${feedbackKey(hit.fbSeq)} is a duplicate of ${hit.duplicateOf}, which no feedback row holds`,
      );
    }
    return root;
  };
  const routeIssues = await routeIssuesOf([...new Set(hits.map(rootOf))]);
  const issueIds = [...new Set([...routeIssues.values()].flat())];
  const [prefix, issueRows] = await Promise.all([
    activeIssuePrefix(projectId),
    issueIds.length === 0 ? [] : carrierIssueRows(issueIds),
  ]);
  const keyOf = new Map(issueRows.map((i) => [i.id, formatIssueRef(prefix, i.seq)]));
  return (hit) => {
    const root = rootOf(hit);
    return {
      duplicateOf: root === hit ? null : feedbackKey(root.fbSeq),
      carriers: (routeIssues.get(root.id) ?? []).map((id) => {
        const key = keyOf.get(id);
        if (!key) {
          throw new Error(
            `${feedbackKey(root.fbSeq)} is carried by issue ${id}, which the carriers' read did not load`,
          );
        }
        return key;
      }),
    };
  };
}

export async function similarFeedbackAs(
  viewer: FeedbackActor,
  projectId: string,
  ref: string,
  door: ReadDoor = {},
  limit = 5,
): Promise<SimilarFeedbackResponse> {
  await requireDeclaredOn(projectId, viewer.userId, 'project.read');
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
  await requireDeclaredOn(projectId, viewer.userId, 'project.read');
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
