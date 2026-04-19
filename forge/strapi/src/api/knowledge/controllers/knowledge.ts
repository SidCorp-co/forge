import {
  upsertEmbedding,
  removeEmbeddings,
  searchSimilar,
  sanitizeContent,
} from '../../../services/embeddings';
import { rerank } from '../../../services/embeddings/reranker';
import { crossEncoderRerank, buildScoreMap } from '../../../services/embeddings/cross-encoder';
import { getQdrantClient } from '../../../services/embeddings/qdrant';

const PROJECT_UID = 'api::project.project' as any;

const MAX_DOCS_PER_REQUEST = 20;
const MAX_DOC_CONTENT_BYTES = 50 * 1024; // 50KB

// In-memory rate limiter: key -> { count, resetAt }
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, limit = 100): boolean {
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

async function resolveProjectByApiKey(
  strapi: any,
  apiKey: string
): Promise<{ documentId: string; slug: string } | null> {
  const projects: any[] = await strapi.documents(PROJECT_UID).findMany({
    filters: { apiKey: { $eq: apiKey } },
  });
  if (!projects || projects.length === 0) return null;
  return { documentId: projects[0].documentId, slug: projects[0].slug };
}

export default {
  /**
   * POST /api/knowledge/ingest
   * Ingest knowledge documents for a project identified by X-Forge-API-Key.
   */
  async ingest(ctx: any) {
    const strapi = globalThis.strapi;
    const apiKey = ctx.request.headers['x-forge-api-key'];
    if (!apiKey) {
      return ctx.unauthorized('Missing X-Forge-API-Key header');
    }

    const project = await resolveProjectByApiKey(strapi, apiKey);
    if (!project) {
      return ctx.unauthorized('Invalid API key');
    }

    if (!checkRateLimit(`ingest:${project.documentId}`)) {
      ctx.status = 429;
      ctx.body = { error: 'Rate limit exceeded. Max 100 requests per minute.' };
      return;
    }

    const body = ctx.request.body as any;
    const documents: any[] = body?.documents;
    if (!Array.isArray(documents) || documents.length === 0) {
      return ctx.badRequest('Body must contain a non-empty "documents" array');
    }
    if (documents.length > MAX_DOCS_PER_REQUEST) {
      return ctx.badRequest(`Maximum ${MAX_DOCS_PER_REQUEST} documents per request`);
    }

    let processed = 0;
    let totalChunks = 0;

    for (const doc of documents) {
      if (!doc.id || !doc.title || typeof doc.content !== 'string') {
        strapi.log.warn(`[knowledge.ingest] Skipping malformed doc: ${JSON.stringify(doc?.id)}`);
        continue;
      }

      const contentBytes = Buffer.byteLength(doc.content, 'utf8');
      if (contentBytes > MAX_DOC_CONTENT_BYTES) {
        strapi.log.warn(
          `[knowledge.ingest] Skipping doc ${doc.id}: content exceeds 50KB (${contentBytes} bytes)`
        );
        continue;
      }

      const text = sanitizeContent(`${doc.title}\n\n${doc.content}`);

      try {
        await upsertEmbedding({
          project_id: project.documentId,
          source_type: 'knowledge',
          source_id: String(doc.id),
          text,
          metadata: {
            title: doc.title,
            category: doc.category ?? null,
            ...(doc.metadata ?? {}),
          },
          contextual: true,
        });
        processed++;
        totalChunks += Math.max(1, Math.ceil(text.length / 500));
      } catch (err: any) {
        strapi.log.error(`[knowledge.ingest] Failed to embed doc ${doc.id}: ${err.message}`);
      }
    }

    ctx.body = { ok: true, processed, chunks: totalChunks };
  },

  /**
   * DELETE /api/knowledge/:docId
   * Remove all embeddings for a knowledge document.
   */
  async remove(ctx: any) {
    const strapi = globalThis.strapi;
    const apiKey = ctx.request.headers['x-forge-api-key'];
    if (!apiKey) {
      return ctx.unauthorized('Missing X-Forge-API-Key header');
    }

    const project = await resolveProjectByApiKey(strapi, apiKey);
    if (!project) {
      return ctx.unauthorized('Invalid API key');
    }

    const { docId } = ctx.params;
    if (!docId) {
      return ctx.badRequest('Missing docId parameter');
    }

    await removeEmbeddings('knowledge', docId);
    ctx.body = { ok: true };
  },

  /**
   * GET /api/knowledge/search
   * Semantic search across a project's embeddings.
   * Query params: query, project (slug), limit, sourceTypes (comma-separated)
   */
  async search(ctx: any) {
    const strapi = globalThis.strapi;
    const apiKey = ctx.request.headers['x-forge-api-key'];
    if (!apiKey) {
      return ctx.unauthorized('Missing X-Forge-API-Key header');
    }

    const project = await resolveProjectByApiKey(strapi, apiKey);
    if (!project) {
      return ctx.unauthorized('Invalid API key');
    }

    if (!checkRateLimit(`search:${project.documentId}`)) {
      ctx.status = 429;
      ctx.body = { error: 'Rate limit exceeded. Max 100 requests per minute.' };
      return;
    }

    const { query, limit, sourceTypes } = ctx.query as Record<string, string>;
    if (!query || query.trim().length === 0) {
      return ctx.badRequest('Missing required query parameter "query"');
    }

    const topK = Math.min(parseInt(limit ?? '10', 10) || 10, 50);
    const sourceTypeList = sourceTypes
      ? sourceTypes.split(',').map((s: string) => s.trim()).filter(Boolean)
      : undefined;

    const raw = await searchSimilar(project.documentId, query.trim(), topK * 3, sourceTypeList);
    const ceResults = await crossEncoderRerank(query.trim(), raw, topK * 2);
    const ceScores = ceResults ? buildScoreMap(ceResults) : undefined;
    const ranked = rerank(raw, query.trim(), topK, undefined, ceScores);

    ctx.body = ranked.map((r) => ({
      sourceType: r.payload.source_type,
      sourceId: r.payload.source_id,
      content: r.payload.text,
      metadata: r.payload.metadata,
      score: r.finalScore,
    }));
  },

  /**
   * POST /api/knowledge/sync
   * Webhook for external services to trigger MCP re-sync.
   * Hub calls this when data changes — Forge pulls fresh data via MCP.
   *
   * Body: { server?: string } — optional: which MCP server changed (syncs all if omitted)
   */
  async sync(ctx: any) {
    const strapi = globalThis.strapi;
    const apiKey = ctx.request.headers['x-forge-api-key'];
    if (!apiKey) {
      return ctx.unauthorized('Missing X-Forge-API-Key header');
    }

    const project = await resolveProjectByApiKey(strapi, apiKey);
    if (!project) {
      return ctx.unauthorized('Invalid API key');
    }

    if (!checkRateLimit(`sync:${project.documentId}`, 10)) {
      ctx.status = 429;
      ctx.body = { error: 'Rate limit exceeded. Max 10 sync requests per minute.' };
      return;
    }

    const fullProject = await strapi.documents(PROJECT_UID).findOne({
      documentId: project.documentId,
    });

    if (!fullProject?.mcpServers || Object.keys(fullProject.mcpServers).length === 0) {
      return ctx.badRequest('Project has no MCP servers configured');
    }

    const { server } = (ctx.request.body || {}) as { server?: string };

    // Filter to specific server if requested
    if (server && !fullProject.mcpServers[server]) {
      return ctx.badRequest(`MCP server "${server}" not found on project`);
    }

    const syncProject = server
      ? { ...fullProject, mcpServers: { [server]: fullProject.mcpServers[server] } }
      : fullProject;

    // Fire-and-forget sync
    import('../../../services/agent/mcp-sync').then(({ syncMcpKnowledge }) => {
      syncMcpKnowledge(strapi, syncProject).catch(err =>
        strapi.log.warn(`[knowledge.sync] Webhook sync failed: ${err}`)
      );
    });

    ctx.body = { ok: true, message: 'Sync started' };
  },

  /**
   * POST /api/knowledge/backfill
   * Backfill existing embeddings with LLM-generated contextual prefixes.
   * Processes in background, returns immediately.
   *
   * Body: { sourceTypes?: string[], batchSize?: number, dryRun?: boolean }
   */
  async backfill(ctx: any) {
    const strapi = globalThis.strapi;
    const apiKey = ctx.request.headers['x-forge-api-key'];
    if (!apiKey) {
      return ctx.unauthorized('Missing X-Forge-API-Key header');
    }

    const project = await resolveProjectByApiKey(strapi, apiKey);
    if (!project) {
      return ctx.unauthorized('Invalid API key');
    }

    if (!checkRateLimit(`backfill:${project.documentId}`, 5)) {
      ctx.status = 429;
      ctx.body = { error: 'Rate limit exceeded. Max 5 backfill requests per minute.' };
      return;
    }

    const { sourceTypes, batchSize = 10, dryRun = false } = (ctx.request.body || {}) as {
      sourceTypes?: string[];
      batchSize?: number;
      dryRun?: boolean;
    };

    const jobId = `backfill:${project.documentId}:${Date.now()}`;

    // Fire-and-forget background processing
    setImmediate(async () => {
      const qdrant = getQdrantClient();
      if (!qdrant) {
        strapi.log.warn(`[knowledge.backfill] Qdrant not available`);
        return;
      }

      let processed = 0;
      let skipped = 0;
      let failed = 0;
      let offset: string | number | undefined = undefined;
      const COLLECTION = 'forge_embeddings';
      const scrollLimit = Math.min(batchSize, 50);

      try {
        // Phase 1: Collect all points that need backfill, grouped by source_id
        const groups = new Map<string, { sourceType: string; points: { id: any; chunkIndex: number; text: string; payload: any }[] }>();

        while (true) {
          const must: any[] = [
            { key: 'project_id', match: { value: project.documentId } },
          ];
          if (sourceTypes?.length) {
            must.push({ key: 'source_type', match: { any: sourceTypes } });
          }

          const result = await qdrant.scroll(COLLECTION, {
            filter: { must },
            with_payload: true,
            limit: scrollLimit,
            ...(offset !== undefined && { offset }),
          });

          const points = result.points || [];
          if (points.length === 0) break;

          for (const point of points) {
            const payload = point.payload as any;
            if (payload?.contextual_prefix) {
              skipped++;
              continue;
            }

            const text = payload?.text || '';
            const sourceId = payload?.source_id || '';
            const sourceType = payload?.source_type || '';
            if (!text || !sourceId) { skipped++; continue; }

            if (!groups.has(sourceId)) {
              groups.set(sourceId, { sourceType, points: [] });
            }
            groups.get(sourceId)!.points.push({
              id: point.id,
              chunkIndex: payload?.chunk_index ?? 0,
              text,
              payload,
            });
          }

          offset = result.next_page_offset as any;
          if (offset === undefined || offset === null) break;
        }

        // Phase 2: Process each source_id group — re-embed via upsertEmbedding (full pipeline)
        for (const [sourceId, group] of groups) {
          try {
            // Sort chunks by index to reconstruct document order
            group.points.sort((a, b) => a.chunkIndex - b.chunkIndex);
            const fullDocument = group.points.map((p) => p.text).join('\n\n');
            const metadata = group.points[0]?.payload?.metadata || {};

            if (!dryRun) {
              // Re-embed through full pipeline (dense + sparse + contextual prefix)
              await upsertEmbedding({
                project_id: project.documentId,
                source_type: group.sourceType,
                source_id: sourceId,
                text: fullDocument,
                metadata,
                contextual: true,
              });
            }
            processed += group.points.length;
          } catch (err: any) {
            failed += group.points.length;
            strapi.log.warn(`[knowledge.backfill] Failed source ${sourceId}: ${err.message}`);
          }
        }

        strapi.log.info(
          `[knowledge.backfill] ${jobId} complete: processed=${processed} skipped=${skipped} failed=${failed}${dryRun ? ' (dry run)' : ''}`,
        );
      } catch (err: any) {
        strapi.log.error(`[knowledge.backfill] ${jobId} error: ${err.message}`);
      }
    });

    ctx.body = { ok: true, jobId, message: 'Backfill started in background' };
  },

  /**
   * GET /api/knowledge/health
   * Reports entity extraction health: memories with/without entities, total edges.
   */
  async health(ctx: any) {
    const strapi = globalThis.strapi;
    const apiKey = ctx.request.headers['x-forge-api-key'];
    if (!apiKey) {
      return ctx.unauthorized('Missing X-Forge-API-Key header');
    }

    const project = await resolveProjectByApiKey(strapi, apiKey);
    if (!project) {
      return ctx.unauthorized('Invalid API key');
    }

    const qdrant = getQdrantClient();
    if (!qdrant) {
      ctx.status = 503;
      ctx.body = { error: 'Qdrant not available' };
      return;
    }

    const COLLECTION = 'forge_embeddings';
    let totalMemories = 0;
    let withEntities = 0;
    let withoutEntities = 0;

    // Scroll through all memory points for this project (cap at 10k to prevent runaway)
    const MAX_SCROLL_ITERATIONS = 100;
    let iterations = 0;
    let offset: string | number | undefined = undefined;
    while (iterations < MAX_SCROLL_ITERATIONS) {
      iterations++;
      const result = await qdrant.scroll(COLLECTION, {
        filter: {
          must: [
            { key: 'project_id', match: { value: project.documentId } },
            { key: 'source_type', match: { value: 'memory' } },
          ],
        },
        with_payload: ['entities'],
        limit: 100,
        ...(offset !== undefined && { offset }),
      });

      const points = result.points || [];
      if (points.length === 0) break;

      for (const point of points) {
        const entities = (point.payload as any)?.entities;
        totalMemories++;
        if (Array.isArray(entities) && entities.length > 0) {
          withEntities++;
        } else {
          withoutEntities++;
        }
      }

      offset = result.next_page_offset as any;
      if (offset === undefined || offset === null) break;
    }

    // Count knowledge graph edges
    let totalEdges = 0;
    try {
      const edgeResult = await strapi.db.connection.raw(
        `SELECT COUNT(*) as count FROM knowledge_edges WHERE project = ?`,
        [project.documentId],
      );
      totalEdges = edgeResult?.[0]?.count ?? edgeResult?.rows?.[0]?.count ?? 0;
    } catch {
      // Table may not exist yet
    }

    const healthyPct = totalMemories > 0 ? Math.round((withEntities / totalMemories) * 100) : 0;

    ctx.body = { totalMemories, withEntities, withoutEntities, totalEdges, healthyPct };
  },
};
