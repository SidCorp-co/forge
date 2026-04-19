import { getQdrantClient } from '../embeddings/qdrant';
import { removeEmbeddings } from '../embeddings';
import { invalidateEdgesBySource } from '../knowledge-graph';

const COLLECTION_NAME = 'forge_embeddings';
const PRUNE_ZERO_RETRIEVAL_DAYS = 30;
const PRUNE_LOW_RETRIEVAL_DAYS = 90;
const PRUNE_LOW_RETRIEVAL_THRESHOLD = 3;
const EDGE_STALE_DAYS = 60;

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Prune stale memory embeddings for a project.
 *
 * Removes:
 * - retrievalCount === 0 AND createdAt > 30 days ago
 * - updatedAt > 90 days ago AND retrievalCount < 3
 */
export async function pruneStaleMemories(strapi: any, projectDocId: string): Promise<void> {
  const qdrant = getQdrantClient();
  if (!qdrant) return;

  const log = strapi.log;
  const now = new Date();
  const cutoff30 = daysAgo(PRUNE_ZERO_RETRIEVAL_DAYS);
  const cutoff90 = daysAgo(PRUNE_LOW_RETRIEVAL_DAYS);

  let offset: string | null | undefined = undefined;
  const toDelete: string[] = [];

  // Scroll through all memory points for this project
  do {
    const response = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'source_type', match: { value: 'memory' } },
          { key: 'project_id', match: { value: projectDocId } },
        ],
      },
      limit: 250,
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: false,
    });

    for (const point of response.points) {
      const payload = point.payload as any;
      const meta = payload?.metadata ?? {};
      const sourceId: string = payload?.source_id ?? '';
      const retrievalCount: number = meta.retrievalCount ?? 0;
      const createdAt = meta.createdAt ? new Date(meta.createdAt) : null;
      const updatedAt = meta.updatedAt ? new Date(meta.updatedAt) : null;

      const neverRetrievedAndOld =
        retrievalCount === 0 && createdAt !== null && createdAt < cutoff30;

      const rarelyRetrievedAndVeryOld =
        retrievalCount < PRUNE_LOW_RETRIEVAL_THRESHOLD &&
        updatedAt !== null &&
        updatedAt < cutoff90;

      if ((neverRetrievedAndOld || rarelyRetrievedAndVeryOld) && sourceId) {
        toDelete.push(sourceId);
      }
    }

    offset = response.next_page_offset as string | null | undefined;
  } while (offset != null);

  // Deduplicate source IDs and remove
  const uniqueIds = [...new Set(toDelete)];
  for (const sourceId of uniqueIds) {
    await removeEmbeddings('memory', sourceId);
    // Also invalidate knowledge graph edges sourced from this memory
    await invalidateEdgesBySource(strapi, projectDocId, `memory:${sourceId}`).catch((err: any) =>
      log.debug(`[memory-lifecycle] edge invalidation failed for ${sourceId}: ${err}`));
  }

  log.info(`[memory-lifecycle] Pruned ${uniqueIds.length} stale memories for project ${projectDocId}`);
}

/**
 * Invalidate knowledge edges whose source memory references a closed or missing issue.
 *
 * Sets validUntil = now on edges where:
 * - validFrom > 60 days ago (edge is old enough to check)
 * - sourceMemoryId starts with 'issue:'
 * - The referenced issue no longer exists or has status 'closed'
 */
export async function invalidateStaleEdges(strapi: any, projectDocId: string): Promise<void> {
  const log = strapi.log;
  const now = new Date();
  const cutoff60 = daysAgo(EDGE_STALE_DAYS);

  // Find edges older than 60 days that haven't already been invalidated
  const edges = await strapi.documents('api::knowledge-edge.knowledge-edge' as any).findMany({
    filters: {
      project: { documentId: projectDocId },
      validFrom: { $lt: cutoff60.toISOString() },
      validUntil: { $null: true },
    },
    fields: ['documentId', 'sourceMemoryId', 'validFrom', 'validUntil'],
    pagination: { pageSize: 500 },
  });

  let invalidatedCount = 0;

  for (const edge of edges ?? []) {
    const sourceMemoryId: string = edge.sourceMemoryId ?? '';
    let shouldInvalidate = false;

    if (sourceMemoryId.startsWith('issue:') || sourceMemoryId.startsWith('issue-relation:')) {
      // Check if referenced issue still exists and is not closed
      const issueDocId = sourceMemoryId.replace(/^issue(?:-relation)?:/, '');
      try {
        const issue = await strapi.documents('api::issue.issue' as any).findOne({
          documentId: issueDocId,
          fields: ['documentId', 'status'],
        });
        if (!issue || issue.status === 'closed') {
          shouldInvalidate = true;
        }
      } catch {
        shouldInvalidate = true;
      }
    } else if (sourceMemoryId.startsWith('memory:')) {
      // Check if referenced memory still exists in Qdrant
      const memSourceId = sourceMemoryId.replace(/^memory:/, '');
      try {
        const qdrant = getQdrantClient();
        if (qdrant) {
          const result = await qdrant.scroll(COLLECTION_NAME, {
            filter: {
              must: [
                { key: 'source_type', match: { value: 'memory' } },
                { key: 'source_id', match: { value: memSourceId } },
              ],
            },
            limit: 1,
            with_payload: false,
            with_vector: false,
          });
          if (!result.points?.length) {
            shouldInvalidate = true;
          }
        }
      } catch {
        // Can't verify, skip
      }
    }

    if (shouldInvalidate) {
      await strapi.documents('api::knowledge-edge.knowledge-edge' as any).update({
        documentId: edge.documentId,
        data: { validUntil: now.toISOString() },
      });
      invalidatedCount++;
    }
  }

  log.info(`[memory-lifecycle] Invalidated ${invalidatedCount} stale edges for project ${projectDocId}`);
}
