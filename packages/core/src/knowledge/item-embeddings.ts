/**
 * The one `item_embeddings` writer (Q7), for every item kind the arc holds: one row per item, of its
 * head only. A write never skips in silence: no provider is `provider_not_configured`, a provider
 * error `failed`, and a project whose data policy keeps content in place `withheld_by_policy` (Q8).
 */

import { createHash } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { type ItemEmbeddingStatus, itemEmbeddings } from '../db/schema-item-embeddings.js';

export type { ItemEmbeddingStatus };

import { embeddingsConfigured, embedWithModel } from '../integrations/llm/index.js';
import { dataPolicyOf, type EgressSurface, egressText } from '../lib/data-egress.js';

export const EMBEDDING_PROVIDER_NOT_CONFIGURED =
  'embedding provider not configured: EMBEDDINGS_BASE_URL and EMBEDDINGS_API_KEY are unset, so no vector was written and dedup cannot compare this item';

export type ItemArc = { requirementId: string } | { feedbackId: string };

export interface ItemHead {
  projectId: string;
  arc: ItemArc;
  version: number;
  text: string;
  /** How a refusal names the item: "REQ-3", "FB-12". */
  what: string;
}

async function upsert(
  head: ItemHead,
  hash: string,
  written: { status: ItemEmbeddingStatus; vector?: number[]; model?: string; error?: string },
) {
  const values = {
    projectId: head.projectId,
    requirementId: 'requirementId' in head.arc ? head.arc.requirementId : null,
    feedbackId: 'feedbackId' in head.arc ? head.arc.feedbackId : null,
    version: head.version,
    contentHash: hash,
    status: written.status,
    model: written.model ?? null,
    embedding: written.vector ?? null,
    error: written.error ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(itemEmbeddings)
    .values(values)
    .onConflictDoUpdate({ target: [itemEmbeddings.itemType, itemEmbeddings.itemId], set: values });
}

const surfaceOf = (arc: ItemArc): EgressSurface =>
  'requirementId' in arc ? 'requirement' : 'feedback';

/** A text's vector as its project's data policy allows, or the status that says why there is none. */
export type DraftEmbedding =
  | { status: 'embedded'; vector: number[]; model: string; hash: string }
  | { status: Exclude<ItemEmbeddingStatus, 'embedded'>; error: string; hash: string };

/**
 * One text embedded through the policy gate every item vector passes: withheld on a project whose
 * data policy keeps content in place, refused where no provider is configured, failed on a provider
 * error. Nothing is stored: an item's own row is `writeItemEmbedding`'s.
 */
export async function embedText(
  projectId: string,
  surface: EgressSurface,
  text: string,
  what: string,
): Promise<DraftEmbedding> {
  const scope = { level: await dataPolicyOf(projectId), surface, what };
  const egress = egressText(scope.level, scope.surface, text, scope.what);
  if (!egress.ok) {
    const hash = createHash('sha256').update(text).digest('hex');
    return { status: 'withheld_by_policy', error: egress.refusal.detail, hash };
  }
  const hash = createHash('sha256').update(egress.text).digest('hex');
  if (!embeddingsConfigured()) {
    return { status: 'provider_not_configured', error: EMBEDDING_PROVIDER_NOT_CONFIGURED, hash };
  }
  try {
    const { vector, model } = await embedWithModel(scope, egress.text);
    return { status: 'embedded', vector, model, hash };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err), hash };
  }
}

/** Embeds the item's head as its project's data policy allows, replacing whatever row it held. */
export async function writeItemEmbedding(head: ItemHead): Promise<ItemEmbeddingStatus> {
  const out = await embedText(head.projectId, surfaceOf(head.arc), head.text, head.what);
  await upsert(
    head,
    out.hash,
    out.status === 'embedded'
      ? { status: 'embedded', vector: out.vector, model: out.model }
      : { status: out.status, error: out.error },
  );
  return out.status;
}

export type ItemKind = 'requirement' | 'feedback';

export interface StoredItemEmbedding {
  status: ItemEmbeddingStatus;
  embedding: number[] | null;
  model: string | null;
  error: string | null;
}

/** The row an item holds, or null when none was written yet. */
export async function itemEmbeddingOf(arc: ItemArc): Promise<StoredItemEmbedding | null> {
  const [row] = await db
    .select({
      status: itemEmbeddings.status,
      embedding: itemEmbeddings.embedding,
      model: itemEmbeddings.model,
      error: itemEmbeddings.error,
    })
    .from(itemEmbeddings)
    .where(
      'requirementId' in arc
        ? eq(itemEmbeddings.requirementId, arc.requirementId)
        : eq(itemEmbeddings.feedbackId, arc.feedbackId),
    );
  return row ?? null;
}

export interface NearestItem {
  itemId: string;
  /** The item version the vector was taken of. */
  version: number;
  similarity: number;
}

/** The embedded items of one kind in `projectId` nearest to `vector`, comparing only vectors of
 *  the same model, nearest first; `exclude` leaves the asking item out. */
export async function nearestItems(by: {
  projectId: string;
  kind: ItemKind;
  vector: number[];
  model: string;
  exclude?: string;
  limit: number;
}): Promise<NearestItem[]> {
  const distance = cosineDistance(itemEmbeddings.embedding, by.vector);
  const rows = await db
    .select({
      itemId: sql<string>`${itemEmbeddings.itemId}`,
      version: itemEmbeddings.version,
      distance: sql<number>`${distance}`,
    })
    .from(itemEmbeddings)
    .where(
      and(
        eq(itemEmbeddings.projectId, by.projectId),
        eq(itemEmbeddings.itemType, by.kind),
        eq(itemEmbeddings.status, 'embedded'),
        eq(itemEmbeddings.model, by.model),
        ...(by.exclude ? [ne(itemEmbeddings.itemId, by.exclude)] : []),
      ),
    )
    .orderBy(distance)
    .limit(by.limit);
  return rows.map((r) => ({
    itemId: r.itemId,
    version: r.version,
    similarity: Math.round((1 - Number(r.distance)) * 1000) / 1000,
  }));
}

/** Items of one kind in `projectId` with no vector `model` can compare, counted by row status. */
export async function unembeddedCounts(
  projectId: string,
  kind: ItemKind,
  model: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: itemEmbeddings.status, n: sql<number>`count(*)::int` })
    .from(itemEmbeddings)
    .where(
      and(
        eq(itemEmbeddings.projectId, projectId),
        eq(itemEmbeddings.itemType, kind),
        sql`(${itemEmbeddings.status} <> 'embedded' OR ${itemEmbeddings.model} <> ${model})`,
      ),
    )
    .groupBy(itemEmbeddings.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** The embedding of a feedback, removed with what the reporter gave (UC15). */
export async function deleteFeedbackEmbedding(tx: Tx, feedbackId: string): Promise<void> {
  await tx.delete(itemEmbeddings).where(eq(itemEmbeddings.feedbackId, feedbackId));
}
