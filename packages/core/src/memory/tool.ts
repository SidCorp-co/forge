import { z } from 'zod';
import { memorySources } from '../db/schema.js';
import { EmbeddingUnavailableError } from '../integrations/embeddings/index.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { requireCan } from '../permissions/index.js';
import { memoryFeedbackInputSchema, runMemoryFeedback } from './feedback-service.js';
import { getMemoryInputSchema, runMemoryGet } from './get-service.js';
import { deleteMemory } from './indexer.js';
import { memorySearchStrategies, runMemorySearch } from './search-service.js';
import { runMemoryWrite, writeMemoryInputSchema } from './write-service.js';

const ACTIONS = ['search', 'write', 'get', 'delete', 'feedback'] as const;

const deleteInputSchema = z.object({
  projectId: z.uuid(),
  source: z.enum(memorySources),
  sourceRef: z.string().trim().min(1).max(512),
});

const searchInputSchema = z.object({
  projectId: z.uuid(),
  query: z.string().trim().min(1).max(4000),
  topK: z.number().int().min(1).max(50).default(10),
  sourceFilter: z.array(z.enum(memorySources)).optional(),
  strategy: z.enum(memorySearchStrategies).default('semantic'),
});

/** What the tool lists: every field any action takes, each optional but `action` and `projectId`. */
const listedSchema = z
  .object({
    action: z.enum(ACTIONS),
    ...searchInputSchema.partial().shape,
    ...getMemoryInputSchema.partial().shape,
    ...writeMemoryInputSchema.partial().shape,
    ...memoryFeedbackInputSchema.partial().shape,
    projectId: z.uuid(),
    source: z.enum(memorySources).optional(),
  })
  .strict();

const actionOf = z.object({ action: z.enum(ACTIONS) }).loose();

function withoutAction(args: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = args;
  return rest;
}

const DESCRIPTION =
  `Project memory, the same service \`/api/memory\` serves. Actions: ${ACTIONS.join(' | ')}. ` +
  '`search` { query, topK?, sourceFilter?, strategy? }: semantic (default, cosine scores), keyword (Postgres FTS — exact identifiers, error codes) or hybrid (RRF fusion; scores are fused ranks). A semantic or hybrid search costs one embedding call (`embedMs`). When the question names an issue key, a status or a count, answer from the tracker (`forge issue …`) and do not search. Rows carrying `via` are one-hop neighbours of an issue hit (score 0, context, not matches); a hit with `stale: true` was superseded (`supersededBy`). Hits are point-in-time: verify, then report with `feedback`. ' +
  '`write` { source, sourceRef, textContent, metadata? }: upsert under (projectId, source, sourceRef) — the ref you name is the ref written, and a rewrite REPLACES its body (the old one stays readable at `GET /api/memory/revisions`). Answers {id, embeddedAt, truncated, degraded, nearDuplicateOf?, dedupeScore?}; nearDuplicateOf is advisory — refine that record by writing under its sourceRef. Agent-authored sources (note/knowledge/policy): textContent ≤8192 chars and no fenced code block over 5 lines. ' +
  '`get` { source?, sourceRef?, metadataFilter?, includeArchived?, limit?, offset?, orderBy?, orderDir? }: natural-key lookup, no embedding; includeArchived also answers soft-deleted rows, each carrying archivedAt. ' +
  '`delete` { source, sourceRef }: idempotent, answers {deleted}. ' +
  '`feedback` { source, sourceRef, verdict: confirmed | outdated, evidence? }: confirmed protects the row from usage decay; outdated archives it now and needs evidence. note/knowledge only. ' +
  'search and get need project membership; write, delete and feedback need writer access.';

export const forgeMemoryTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_memory',
  reach: 'project',
  route: '/api/memory',
  grant: {
    byAction: {
      search: 'knowledge:read',
      get: 'knowledge:read',
      write: 'knowledge:write',
      delete: 'knowledge:write',
      feedback: 'knowledge:write',
    },
  },
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(listedSchema),
  handler: async (args) => {
    const { action } = actionOf.parse(args);
    const rest = withoutAction(args);

    if (action === 'search') {
      const input = searchInputSchema.parse(rest);
      await requireCan({ userId: principal.userId }, 'project.read', input.projectId);
      try {
        return await runMemorySearch({ ...input, surface: 'agent' });
      } catch (err) {
        if (err instanceof EmbeddingUnavailableError)
          throw new Error(`UNAVAILABLE: ${err.message}`);
        throw err;
      }
    }

    if (action === 'get') {
      const input = getMemoryInputSchema.parse(rest);
      await requireCan({ userId: principal.userId }, 'project.read', input.projectId);
      return runMemoryGet(input);
    }

    if (action === 'delete') {
      const input = deleteInputSchema.parse(rest);
      await requireCan({ userId: principal.userId }, 'project.write', input.projectId);
      const removed = await deleteMemory(input.projectId, input.source, input.sourceRef);
      return { deleted: removed > 0 };
    }

    if (action === 'feedback') {
      const input = memoryFeedbackInputSchema.parse(rest);
      await requireCan({ userId: principal.userId }, 'project.write', input.projectId);
      return await runMemoryFeedback(input);
    }

    const input = writeMemoryInputSchema.parse(rest);
    await requireCan({ userId: principal.userId }, 'project.write', input.projectId);
    try {
      return await runMemoryWrite(input);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw new Error(`UNAVAILABLE: ${err.message}`);
      throw err;
    }
  },
});
