/**
 * The one `item_embeddings` writer (Q7), for every item kind the arc holds: one row per item, of its
 * head only. A write never skips in silence: no provider is `provider_not_configured`, a provider
 * error `failed`, and a project whose data policy keeps content in place `withheld_by_policy` (Q8).
 */

import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { type ItemEmbeddingStatus, itemEmbeddings } from '../db/schema-item-embeddings.js';
import { egressFor } from '../lib/data-egress.js';
import { embeddingsConfigured, embedWithModel } from './index.js';

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

/** Embeds the item's head as its project's data policy allows, replacing whatever row it held. */
export async function writeItemEmbedding(head: ItemHead): Promise<ItemEmbeddingStatus> {
  const egress = await egressFor(head.projectId, head.text, head.what);
  if (!egress.ok) {
    const hash = createHash('sha256').update(head.text).digest('hex');
    await upsert(head, hash, { status: 'withheld_by_policy', error: egress.refusal.detail });
    return 'withheld_by_policy';
  }
  const hash = createHash('sha256').update(egress.text).digest('hex');
  if (!embeddingsConfigured()) {
    await upsert(head, hash, {
      status: 'provider_not_configured',
      error: EMBEDDING_PROVIDER_NOT_CONFIGURED,
    });
    return 'provider_not_configured';
  }
  try {
    const { vector, model } = await embedWithModel(egress.text);
    await upsert(head, hash, { status: 'embedded', vector, model });
    return 'embedded';
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await upsert(head, hash, { status: 'failed', error });
    return 'failed';
  }
}
