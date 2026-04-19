/**
 * One-time migration: backfill BM25 sparse vectors for existing Qdrant points.
 * Scrolls all points, computes sparse vectors from stored text + metadata,
 * and updates each point using updateVectors.
 */
import pLimit from 'p-limit';
import { getQdrantClient } from './qdrant';
import { buildDocSparseVector, buildMetadataText } from './bm25';

const COLLECTION_NAME = 'forge_embeddings';
const BATCH_SIZE = 100;
const CONCURRENCY = 3;

/**
 * Check if BM25 sparse vectors need backfilling by sampling a point.
 */
export async function needsBM25Backfill(): Promise<boolean> {
  const qdrant = getQdrantClient();
  const log = (globalThis as any).strapi?.log;
  if (!qdrant) {
    log?.info?.('[bm25-backfill] No Qdrant client — skipping backfill check');
    return false;
  }

  try {
    const sample = await qdrant.scroll(COLLECTION_NAME, {
      limit: 1,
      with_payload: true,
      with_vector: true,
    });

    if (!sample.points?.length) {
      log?.info?.('[bm25-backfill] Collection empty — no backfill needed');
      return false;
    }

    const point = sample.points[0];
    const vectors = point.vector as any;

    // If vectors is a flat array (old format) or missing bm25 named vector, needs backfill
    if (Array.isArray(vectors)) {
      log?.info?.('[bm25-backfill] Sample point has flat vector (no sparse) — backfill needed');
      return true;
    }
    if (!vectors?.bm25) {
      log?.info?.(`[bm25-backfill] Sample point missing bm25 sparse vector — backfill needed. Vector keys: ${Object.keys(vectors || {}).join(', ')}`);
      return true;
    }

    log?.info?.('[bm25-backfill] Sample point already has bm25 sparse vector — no backfill needed');
    return false;
  } catch (err) {
    log?.warn?.(`[bm25-backfill] Backfill check failed: ${err}`);
    return false;
  }
}

/**
 * Backfill all points with BM25 sparse vectors.
 * Rate-limited and async-safe for bootstrap use.
 */
export async function backfillBM25Vectors(): Promise<number> {
  const qdrant = getQdrantClient();
  if (!qdrant) return 0;

  const log = (globalThis as any).strapi?.log;
  const limit = pLimit(CONCURRENCY);
  let total = 0;
  let offset: string | number | undefined = undefined;

  log?.info?.('[bm25-backfill] Starting BM25 sparse vector backfill...');

  while (true) {
    const batch = await qdrant.scroll(COLLECTION_NAME, {
      limit: BATCH_SIZE,
      offset,
      with_payload: true,
      with_vector: false,
    });

    if (!batch.points?.length) break;

    // Batch sparse vector updates to reduce HTTP round-trips
    const batchUpdates: Array<{ id: string | number; vector: { bm25: { indices: number[]; values: number[] } } }> = [];
    for (const point of batch.points) {
      const payload = point.payload as any;
      if (!payload?.text) continue;

      const metadataText = payload.metadata ? buildMetadataText(payload.metadata) : '';
      const sparseVec = buildDocSparseVector(payload.text, metadataText);
      batchUpdates.push({ id: point.id, vector: { bm25: sparseVec } });
    }

    if (batchUpdates.length > 0) {
      // Split into sub-batches of 50 to avoid oversized requests
      const SUB_BATCH = 50;
      const subBatches: typeof batchUpdates[] = [];
      for (let i = 0; i < batchUpdates.length; i += SUB_BATCH) {
        subBatches.push(batchUpdates.slice(i, i + SUB_BATCH));
      }
      await Promise.all(subBatches.map((sub) =>
        limit(() => qdrant.updateVectors(COLLECTION_NAME, { points: sub })),
      ));
    }

    total += batch.points.length;

    if (total % 500 === 0) {
      log?.info?.(`[bm25-backfill] Processed ${total} points...`);
    }

    offset = batch.next_page_offset as string | number | undefined;
    if (!offset) break;
  }

  log?.info?.(`[bm25-backfill] Complete. Backfilled ${total} points with BM25 sparse vectors.`);
  return total;
}
