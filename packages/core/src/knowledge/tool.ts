import { z } from 'zod';
import type { ProjectReader } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, projectReaderOf, zodToMcpSchema } from '../lib/tool.js';
import { onArg } from '../permissions/index.js';
import {
  knowledgeAuthoredByEnum,
  knowledgeConfidenceEnum,
  knowledgeInjectionEnum,
  knowledgeKindEnum,
  upsertKnowledgeInputSchema,
} from './entry-input.js';
import { deleteKnowledgeEntry, listKnowledgeEntries, readKnowledgeEntry } from './service.js';
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

const actions: Record<Input['action'], (input: Input, reader: ProjectReader) => Promise<unknown>> =
  {
    list: async ({ projectId, kindFilter, injectionFilter }) => {
      return listKnowledgeEntries({ projectId, kind: kindFilter, injection: injectionFilter });
    },
    get: async (input) => {
      const slug = required(input.slug, 'slug', 'get');
      const entry = await readKnowledgeEntry(input.projectId, slug);
      if (!entry) throw new Error('NOT_FOUND: knowledge entry not found');
      return entry;
    },
    upsert: async (input) => {
      const slug = required(input.slug, 'slug', 'upsert');
      const title = required(input.title, 'title', 'upsert');
      const body = required(input.body, 'body', 'upsert');
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
    delete: async (input) => {
      const slug = required(input.slug, 'slug', 'delete');
      return { deleted: (await deleteKnowledgeEntry(input.projectId, slug)) > 0 };
    },
    search: async ({ projectId, query, scope, topK, strategy }, reader) => {
      const text = required(query, 'query', 'search');
      return runUnifiedSearch({ projectId, reader, query: text, scope, topK, strategy });
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
  // the door checks each on the project its projectId names, before the handler runs
  permission: {
    byAction: {
      list: onArg('project.read'),
      get: onArg('project.read'),
      upsert: onArg('project.write'),
      delete: onArg('project.write'),
      search: onArg('project.read'),
    },
  },
  description:
    'Read/write curated knowledge entries for a project (stored in `knowledge_entries`). ' +
    'Actions: `list` — project entries (body-free index; use `get` for the full body). ' +
    "`get` — full entry by slug: the project's own or, where it holds none under that slug, its organisation's (`origin: org`). " +
    '`upsert` — create or replace an entry; embeds body for semantic search; tolerates embeddings outage (degraded write). ' +
    '`delete` — idempotent remove. ' +
    '`search` — semantic/keyword/hybrid search; `scope` controls which store(s): ' +
    '"knowledge" (default), "memory", or "all" (both, each hit labeled with `origin`). ' +
    'list/get/search require project membership; upsert/delete require writer access.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    return actions[input.action](input, projectReaderOf(ctx.principal));
  },
});
