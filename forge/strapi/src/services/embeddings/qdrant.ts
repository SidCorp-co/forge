import { QdrantClient } from '@qdrant/js-client-rest';

const COLLECTION_NAME = 'forge_embeddings';
const VECTOR_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE || '1536', 10);

let client: QdrantClient | null = null;
let initFailed = false;

function getLog(): Record<string, (...args: any[]) => void> {
  const log = (globalThis as any).strapi?.log;
  if (!log) return { info: console.log, warn: console.warn, error: console.error };
  return {
    info: log.info.bind(log),
    warn: log.warn.bind(log),
    error: log.error.bind(log),
  };
}

export function getQdrantClient(): QdrantClient | null {
  if (client) return client;
  if (initFailed) return null;

  const url = process.env.QDRANT_URL;
  if (!url) return null;

  try {
    client = new QdrantClient({
      url,
      apiKey: process.env.QDRANT_API_KEY,
      timeout: 10_000,
    });
  } catch (err) {
    initFailed = true;
    getLog().warn(`[embeddings] Qdrant client init failed: ${err}`);
  }

  return client;
}

/** Reset client so next call retries connection (e.g. after transient failure). */
export function resetQdrantClient(): void {
  client = null;
  initFailed = false;
}

export async function ensureQdrantCollection(): Promise<void> {
  const qdrant = getQdrantClient();
  const log = getLog();
  if (!qdrant) {
    log.warn('[embeddings] Qdrant not configured — vector search disabled');
    return;
  }

  try {
    const { collections } = await qdrant.getCollections();
    const exists = collections.some((c) => c.name === COLLECTION_NAME);

    if (!exists) {
      await createCollectionWithNamedVectors(qdrant, log);
    } else {
      // Verify existing collection has correct schema (named dense + bm25 sparse)
      const needsRecreate = await checkCollectionNeedsRecreate(qdrant, log);
      if (needsRecreate) {
        log.warn('[embeddings] Recreating collection with correct named vectors schema');
        await qdrant.deleteCollection(COLLECTION_NAME);
        await createCollectionWithNamedVectors(qdrant, log);
      } else {
        await createPayloadIndexes(qdrant, log);
        log.info(`[embeddings] Qdrant collection '${COLLECTION_NAME}' ready`);
      }
    }

    // Verify sparse vector config
    const info = await qdrant.getCollection(COLLECTION_NAME);
    const hasSparse = info.config?.params?.sparse_vectors && 'bm25' in info.config.params.sparse_vectors;
    const hasNamedDense = info.config?.params?.vectors && typeof info.config.params.vectors === 'object' && 'dense' in info.config.params.vectors;
    log.info(`[embeddings] Collection verified: named_dense=${hasNamedDense ? 'present' : 'MISSING'}, sparse_vectors.bm25=${hasSparse ? 'present' : 'MISSING'}`);
  } catch (err) {
    log.error('[embeddings] Failed to ensure Qdrant collection:', err);
    resetQdrantClient();
  }
}

async function createPayloadIndexes(qdrant: QdrantClient, log: ReturnType<typeof getLog>): Promise<void> {
  const fields = [
    'project_id', 'source_type', 'source_id', 'entities',
    'metadata.role', 'metadata.scope', 'metadata.category',
  ];
  for (const field of fields) {
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: field,
      field_schema: 'keyword',
    }).catch((err) => log.warn(`[embeddings] Index creation failed for '${field}': ${err}`));
  }
  log.info('[embeddings] Created payload indexes');
}

async function createCollectionWithNamedVectors(qdrant: QdrantClient, log: ReturnType<typeof getLog>): Promise<void> {
  await qdrant.createCollection(COLLECTION_NAME, {
    vectors: {
      dense: { size: VECTOR_SIZE, distance: 'Cosine' },
    },
    sparse_vectors: {
      bm25: {},
    },
  });
  log.info(`[embeddings] Created Qdrant collection '${COLLECTION_NAME}' (named dense ${VECTOR_SIZE}d + BM25 sparse)`);
  await createPayloadIndexes(qdrant, log);
}

/**
 * Check if collection needs recreation: must have named dense vectors AND bm25 sparse vectors.
 * Returns true if the collection uses unnamed vectors or is missing sparse vector config.
 */
async function checkCollectionNeedsRecreate(qdrant: QdrantClient, log: ReturnType<typeof getLog>): Promise<boolean> {
  try {
    const info = await qdrant.getCollection(COLLECTION_NAME);
    const hasSparse = info.config?.params?.sparse_vectors && 'bm25' in info.config.params.sparse_vectors;

    // Check if vectors are named (object with 'dense' key) vs unnamed (flat { size, distance })
    const vectorsConfig = info.config?.params?.vectors;
    const hasNamedDense = vectorsConfig && typeof vectorsConfig === 'object' && 'dense' in vectorsConfig;

    if (!hasSparse || !hasNamedDense) {
      log.warn(`[embeddings] Collection schema mismatch: named_dense=${!!hasNamedDense}, bm25_sparse=${!!hasSparse}. Will recreate.`);
      return true;
    }

    return false;
  } catch (err) {
    log.warn(`[embeddings] Collection check failed: ${err}`);
    return true;
  }
}
