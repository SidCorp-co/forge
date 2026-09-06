import { z } from 'zod';
import { EmbeddingUnavailableError } from '../../embeddings/index.js';
import {
  deleteKnowledgeEntry,
  getKnowledgeEntry,
  listKnowledgeEntries,
  upsertKnowledgeEntry,
  upsertKnowledgeInputSchema,
} from '../../knowledge/service.js';
import { runUnifiedSearch } from '../../knowledge/unified-search.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  zodToMcpSchema,
} from './lib.js';

// cm:guard the top-level schema must stay `type: object` — a discriminated union breaks MCP tool listing, which is why per-action validation happens in the handler below rather than in the schema.
const inputSchema = z
  .object({
    action: z.enum(['list', 'get', 'upsert', 'delete', 'search']),
    projectId: z.uuid(),
    slug: z.string().min(1).max(512).optional(),
    title: z.string().min(1).max(500).optional(),
    body: z.string().min(1).max(100_000).optional(),
    kind: z
      .enum(['overview', 'scenario', 'workflow', 'rule', 'guide', 'reference', 'glossary'])
      .optional(),
    injection: z.enum(['always', 'on_demand', 'none']).optional(),
    confidence: z.enum(['verified', 'inferred', 'deprecated']).optional(),
    authoredBy: z.enum(['human', 'agent', 'imported']).optional(),
    orderIndex: z.number().int().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    kindFilter: z
      .enum(['overview', 'scenario', 'workflow', 'rule', 'guide', 'reference', 'glossary'])
      .optional(),
    injectionFilter: z.enum(['always', 'on_demand', 'none']).optional(),
    query: z.string().min(1).max(4000).optional(),
    scope: z.enum(['knowledge', 'memory', 'all']).default('knowledge'),
    topK: z.number().int().min(1).max(50).default(10),
    strategy: z.enum(['semantic', 'keyword', 'hybrid']).default('semantic'),
  })
  .strict();

export const forgeKnowledgeTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_knowledge',
  description:
    'Read/write curated knowledge entries for a project (stored in `knowledge_entries`). ' +
    'Actions: `list` — project entries (body-free index; use `get` for the full body). ' +
    '`get` — full entry by slug. ' +
    '`upsert` — create or replace an entry; embeds body for semantic search; tolerates embeddings outage (degraded write). ' +
    '`delete` — idempotent remove. ' +
    '`search` — semantic/keyword/hybrid search; `scope` controls which store(s): ' +
    '"knowledge" (default), "memory", or "all" (both, each hit labeled with `origin`). ' +
    'list/get/search require project membership; upsert/delete require writer access.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { action, projectId } = input;

    if (action === 'list') {
      await assertPrincipalIsMember(ctx.principal, projectId);
      return listKnowledgeEntries({
        projectId,
        kind: input.kindFilter,
        injection: input.injectionFilter,
      });
    }

    if (action === 'get') {
      if (!input.slug) throw new Error('BAD_REQUEST: slug is required for action=get');
      await assertPrincipalIsMember(ctx.principal, projectId);
      const entry = await getKnowledgeEntry(projectId, input.slug);
      if (!entry) throw new Error('NOT_FOUND: knowledge entry not found');
      return entry;
    }

    if (action === 'upsert') {
      if (!input.slug) throw new Error('BAD_REQUEST: slug is required for action=upsert');
      if (!input.title) throw new Error('BAD_REQUEST: title is required for action=upsert');
      if (!input.body) throw new Error('BAD_REQUEST: body is required for action=upsert');
      await assertPrincipalIsWriter(ctx.principal, projectId);
      try {
        const parsed = upsertKnowledgeInputSchema.parse({
          projectId,
          slug: input.slug,
          title: input.title,
          body: input.body,
          kind: input.kind,
          injection: input.injection,
          confidence: input.confidence,
          authoredBy: input.authoredBy,
          orderIndex: input.orderIndex,
          metadata: input.metadata,
        });
        return await upsertKnowledgeEntry(parsed);
      } catch (err) {
        if (err instanceof EmbeddingUnavailableError) {
          throw new Error(`UNAVAILABLE: ${err.message}`);
        }
        throw err;
      }
    }

    if (action === 'delete') {
      if (!input.slug) throw new Error('BAD_REQUEST: slug is required for action=delete');
      await assertPrincipalIsWriter(ctx.principal, projectId);
      const removed = await deleteKnowledgeEntry(projectId, input.slug);
      return { deleted: removed > 0 };
    }

    // cm:edge contract -> packages/core/src/knowledge/routes.ts — `POST /api/projects/:id/knowledge/search` is this action's REST twin and takes the same four fields; an argument added here without being added there is a capability a client loses by changing transport (ISS-930).
    if (action === 'search') {
      if (!input.query) throw new Error('BAD_REQUEST: query is required for action=search');
      await assertPrincipalIsMember(ctx.principal, projectId);
      try {
        // cm:guard `await` inside the try, not a returned promise — a bare `return runUnifiedSearch(...)` settles outside the catch, so an embeddings outage reached the caller as a raw rejection instead of `UNAVAILABLE:` (found and fixed in ISS-930; the upsert branch had the same shape).
        return await runUnifiedSearch({
          projectId,
          query: input.query,
          scope: input.scope,
          topK: input.topK,
          strategy: input.strategy,
        });
      } catch (err) {
        if (err instanceof EmbeddingUnavailableError) {
          throw new Error(`UNAVAILABLE: ${err.message}`);
        }
        throw err;
      }
    }

    throw new Error(`BAD_REQUEST: unknown action: ${action}`);
  },
});
