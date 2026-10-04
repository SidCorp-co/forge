/**
 * `item_embeddings` for requirements (Q7): one vector per requirement, of its head revision only,
 * written when the head moves and read by the BA assistant's dedup, through the shared writer
 * (`knowledge/item-embeddings.ts`), which applies the project's data policy.
 */

import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cosineDistance } from '../db/pgvector.js';
import { type ItemEmbeddingStatus, itemEmbeddings } from '../db/schema-item-embeddings.js';
import {
  requirementCriteria,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { embeddingsConfigured, embedWithModel } from '../integrations/llm/index.js';
import { EMBEDDING_PROVIDER_NOT_CONFIGURED, writeItemEmbedding } from '../knowledge/index.js';
import { dataPolicyOf, type EgressSurface, egressAt, egressText } from '../lib/data-egress.js';
import { logger } from '../observability/logger.js';

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

/** Embeds the requirement's head revision, replacing whatever vector it held; returns the row status. */
async function embedRequirementHead(requirementId: string): Promise<ItemEmbeddingStatus | null> {
  const head = await headText(requirementId);
  if (!head) return null;
  const [req] = await db
    .select({ seq: requirements.reqSeq })
    .from(requirements)
    .where(eq(requirements.id, requirementId));
  return writeItemEmbedding({
    projectId: head.projectId,
    arc: { requirementId },
    version: head.revision,
    text: head.text,
    what: req ? requirementKey(req.seq) : `requirement ${requirementId}`,
  });
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

type SimilarRequirements =
  | {
      status: 'ok';
      model: string;
      hits: { key: string; title: string; similarity: number; revision: number }[];
      /** Requirements of this project with no usable vector, by row status, so a miss is not read as "none similar". */
      notEmbedded: Record<string, number>;
    }
  | { status: 'provider_not_configured' | 'withheld_by_policy'; message: string };

/** The requirements of `projectId` nearest to `text`, comparing only vectors of the same model. */
export async function similarRequirements(
  projectId: string,
  text: string,
  querySurface: EgressSurface,
  limit = 5,
): Promise<SimilarRequirements> {
  const level = await dataPolicyOf(projectId);
  const egress = egressText(level, querySurface, text, 'the text to compare');
  if (!egress.ok) return { status: 'withheld_by_policy', message: egress.refusal.detail };
  if (!embeddingsConfigured()) {
    return { status: 'provider_not_configured', message: EMBEDDING_PROVIDER_NOT_CONFIGURED };
  }
  const { vector, model } = await embedWithModel(
    { surface: querySurface, level, what: 'the text to compare' },
    egress.text,
  );
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
        eq(itemEmbeddings.itemType, 'requirement'),
        sql`(${itemEmbeddings.status} <> 'embedded' OR ${itemEmbeddings.model} <> ${model})`,
      ),
    )
    .groupBy(itemEmbeddings.status);
  const hits = rows.map((r) => ({
    key: requirementKey(r.seq),
    title: r.title,
    similarity: Math.round((1 - Number(r.distance)) * 1000) / 1000,
    revision: r.revision,
  }));
  const shown = egressAt(level, 'requirement', hits, 'the similar requirements');
  if (!shown.ok) return { status: 'withheld_by_policy', message: shown.refusal.detail };
  return {
    status: 'ok',
    model,
    hits: shown.value,
    notEmbedded: Object.fromEntries(missing.map((m) => [m.status, m.n])),
  };
}
