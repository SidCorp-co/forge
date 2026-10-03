/**
 * `item_embeddings` for requirements (Q7): one vector per requirement, of its head revision only,
 * written when the head moves and read by the BA assistant's dedup. A write never skips in silence:
 * without a provider the row says `provider_not_configured`, a provider error says `failed`.
 */

import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { type ItemEmbeddingStatus, itemEmbeddings } from '../db/schema-item-embeddings.js';
import {
  requirementCriteria,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { embeddingsConfigured, embedWithModel } from '../embeddings/index.js';
import { logger } from '../logger.js';
import { requirementKey } from './read.js';

export const EMBEDDING_PROVIDER_NOT_CONFIGURED =
  'embedding provider not configured: EMBEDDINGS_BASE_URL and EMBEDDINGS_API_KEY are unset, so no vector was written and dedup cannot compare this item';

interface HeadText {
  projectId: string;
  revision: number;
  text: string;
}

async function headText(requirementId: string): Promise<HeadText | null> {
  const [row] = await db
    .select({
      projectId: requirements.projectId,
      title: requirements.title,
      revision: requirements.currentRevision,
      spec: requirementRevisions.spec,
      tldr: requirementRevisions.tldr,
    })
    .from(requirements)
    .innerJoin(
      requirementRevisions,
      and(
        eq(requirementRevisions.requirementId, requirements.id),
        eq(requirementRevisions.revision, requirements.currentRevision),
      ),
    )
    .where(eq(requirements.id, requirementId));
  if (!row || row.revision === null) return null;
  const criteria = await db
    .select({ code: requirementCriteria.code, body: requirementCriteria.body })
    .from(requirementCriteria)
    .where(
      and(
        eq(requirementCriteria.requirementId, requirementId),
        isNull(requirementCriteria.retiredRevision),
      ),
    )
    .orderBy(asc(requirementCriteria.code));
  const spec = (row.spec ?? {}) as { goal?: string; scopeIn?: string[] };
  const text = [
    row.title,
    row.tldr ?? '',
    spec.goal ?? '',
    ...(spec.scopeIn ?? []),
    ...criteria.map((c) => `${c.code} ${c.body}`),
  ]
    .filter((s) => s.trim())
    .join('\n');
  return { projectId: row.projectId, revision: row.revision, text };
}

async function upsert(
  requirementId: string,
  head: HeadText,
  hash: string,
  written: { status: ItemEmbeddingStatus; vector?: number[]; model?: string; error?: string },
) {
  const values = {
    projectId: head.projectId,
    requirementId,
    version: head.revision,
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
    .onConflictDoUpdate({
      target: [itemEmbeddings.itemType, itemEmbeddings.itemId],
      set: values,
    });
}

/** Embeds the requirement's head revision, replacing whatever vector it held; returns the row status. */
export async function embedRequirementHead(
  requirementId: string,
): Promise<ItemEmbeddingStatus | null> {
  const head = await headText(requirementId);
  if (!head) return null;
  const hash = createHash('sha256').update(head.text).digest('hex');
  if (!embeddingsConfigured()) {
    await upsert(requirementId, head, hash, {
      status: 'provider_not_configured',
      error: EMBEDDING_PROVIDER_NOT_CONFIGURED,
    });
    return 'provider_not_configured';
  }
  try {
    const { vector, model } = await embedWithModel(head.text);
    await upsert(requirementId, head, hash, { status: 'embedded', vector, model });
    return 'embedded';
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await upsert(requirementId, head, hash, { status: 'failed', error });
    return 'failed';
  }
}

/** After the head moved: embed outside the transaction that moved it, logging what did not land. */
export function embedRequirementHeadLater(requirementId: string): void {
  embedRequirementHead(requirementId)
    .then((status) => {
      if (status !== 'embedded') {
        logger.warn({ requirementId, status }, 'item_embeddings: the head was not embedded');
      }
    })
    .catch((err: unknown) =>
      logger.error({ err, requirementId }, 'item_embeddings: the embedding row was not written'),
    );
}

export type SimilarRequirements =
  | {
      status: 'ok';
      model: string;
      hits: { key: string; title: string; similarity: number; revision: number }[];
      /** Requirements of this project with no usable vector, by row status, so a miss is not read as "none similar". */
      notEmbedded: Record<string, number>;
    }
  | { status: 'provider_not_configured'; message: string };

/** The requirements of `projectId` nearest to `text`, comparing only vectors of the same model. */
export async function similarRequirements(
  projectId: string,
  text: string,
  limit = 5,
): Promise<SimilarRequirements> {
  if (!embeddingsConfigured()) {
    return { status: 'provider_not_configured', message: EMBEDDING_PROVIDER_NOT_CONFIGURED };
  }
  const { vector, model } = await embedWithModel(text);
  const distance = cosineDistance(itemEmbeddings.embedding, vector);
  const rows = await db
    .select({
      seq: requirements.reqSeq,
      title: requirements.title,
      revision: itemEmbeddings.version,
      distance: sql<number>`${distance}`,
    })
    .from(itemEmbeddings)
    .innerJoin(requirements, eq(requirements.id, itemEmbeddings.requirementId))
    .where(
      and(
        eq(itemEmbeddings.projectId, projectId),
        eq(itemEmbeddings.status, 'embedded'),
        eq(itemEmbeddings.model, model),
      ),
    )
    .orderBy(distance)
    .limit(limit);
  const missing = await db
    .select({ status: itemEmbeddings.status, n: sql<number>`count(*)::int` })
    .from(itemEmbeddings)
    .where(
      and(
        eq(itemEmbeddings.projectId, projectId),
        sql`(${itemEmbeddings.status} <> 'embedded' OR ${itemEmbeddings.model} <> ${model})`,
      ),
    )
    .groupBy(itemEmbeddings.status);
  return {
    status: 'ok',
    model,
    hits: rows.map((r) => ({
      key: requirementKey(r.seq),
      title: r.title,
      similarity: Math.round((1 - Number(r.distance)) * 1000) / 1000,
      revision: r.revision,
    })),
    notEmbedded: Object.fromEntries(missing.map((m) => [m.status, m.n])),
  };
}
