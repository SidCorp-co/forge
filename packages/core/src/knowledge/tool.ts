import { z } from 'zod';
import { EmbeddingUnavailableError } from '../integrations/llm/index.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  knowledgeAuthoredByEnum,
  knowledgeConfidenceEnum,
  knowledgeInjectionEnum,
  knowledgeKindEnum,
  upsertKnowledgeInputSchema,
} from './entry-input.js';
import { deleteKnowledgeEntry, getKnowledgeEntry, listKnowledgeEntries } from './service.js';
import { runUnifiedSearch } from './unified-search.js';
import { upsertKnowledgeEntry } from './upsert.js';

const inputSchema = z
  .object({
    action: z.enum(['list', 'get', 'upsert', 'delete', 'search']),
    projectId: z.uuid(),
    slug: z.string().min(1).max(512).optional(),
    title: z.string().min(1).max(500).optional(),
    body: z.string().min(1).max(100_000).optional(),
    kind: z.enum(knowledgeKindEnum).optional(),
    injection: z.enum(knowledgeInjectionEnum).optional(),
    confidence: z.enum(knowledgeConfidenceEnum).optional(),
    authoredBy: z.enum(knowledgeAuthoredByEnum).optional(),
    orderIndex: z.number().int().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    kindFilter: z.enum(knowledgeKindEnum).optional(),
    injectionFilter: z.enum(knowledgeInjectionEnum).optional(),
    query: z.string().min(1).max(4000).optional(),
    scope: z.enum(['knowledge', 'memory', 'all']).default('knowledge'),
    topK: z.number().int().min(1).max(50).default(10),
    strategy: z.enum(['semantic', 'keyword', 'hybrid']).default('semantic'),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const required = (value: string | undefined, field: string, action: Input['action']): string => {
  if (!value) throw new Error(`BAD_REQUEST: ${field} is required for action=${action}`);
  return value;
};

const requireOn = (
  userId: string,
  permission: Parameters<typeof requireCan>[1],
  projectId: string,
) => requireCan(actorFor(userId), permission, projectResource(projectId));

const actions: Record<Input['action'], (userId: string, input: Input) => Promise<unknown>> = {
  list: async (userId, { projectId, kindFilter, injectionFilter }) => {
    await requireOn(userId, 'project.read', projectId);
    return listKnowledgeEntries({ projectId, kind: kindFilter, injection: injectionFilter });
  },
  get: async (userId, input) => {
    const slug = required(input.slug, 'slug', 'get');
    await requireOn(userId, 'project.read', input.projectId);
    const entry = await getKnowledgeEntry(input.projectId, slug);
    if (!entry) throw new Error('NOT_FOUND: knowledge entry not found');
    return entry;
  },
  upsert: async (userId, input) => {
    const slug = required(input.slug, 'slug', 'upsert');
    const title = required(input.title, 'title', 'upsert');
    const body = required(input.body, 'body', 'upsert');
    await requireOn(userId, 'project.write', input.projectId);
    const { projectId, kind, injection, confidence, authoredBy, orderIndex, metadata } = input;
    return upsertKnowledgeEntry(
      upsertKnowledgeInputSchema.parse({
        projectId,
        slug,
        title,
        body,
        kind,
        injection,
        confidence,
        authoredBy,
        orderIndex,
        metadata,
      }),
    );
  },
  delete: async (userId, input) => {
    const slug = required(input.slug, 'slug', 'delete');
    await requireOn(userId, 'project.write', input.projectId);
    return { deleted: (await deleteKnowledgeEntry(input.projectId, slug)) > 0 };
  },
  search: async (userId, { projectId, query, scope, topK, strategy }) => {
    const text = required(query, 'query', 'search');
    await requireOn(userId, 'project.read', projectId);
    try {
      return await runUnifiedSearch({ projectId, query: text, scope, topK, strategy });
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw new Error(`UNAVAILABLE: ${err.message}`);
      throw err;
    }
  },
};

export const forgeKnowledgeTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_knowledge',
  reach: 'project',
  route: '/api/knowledge',
  grant: {
    byAction: {
      list: 'knowledge:read',
      get: 'knowledge:read',
      upsert: 'knowledge:write',
      delete: 'knowledge:write',
      search: 'knowledge:read',
    },
  },
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
    return actions[input.action](ctx.principal.userId, input);
  },
});
