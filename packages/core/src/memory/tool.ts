import { z } from 'zod';
import { memorySources } from '../db/schema.js';
import { EmbeddingUnavailableError } from '../integrations/llm/index.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { memoryFeedbackInputSchema, runMemoryFeedback } from './feedback-service.js';
import { getMemoryInputSchema, runMemoryGet } from './get-service.js';
import { deleteMemory } from './indexer.js';
import { runMemorySearch, memorySearchInputSchema as searchInputSchema } from './search-service.js';
import { deleteMemoryInputSchema } from './service.js';
import { runMemoryWrite, writeMemoryInputSchema } from './write-service.js';

const ACTIONS = ['search', 'write', 'get', 'delete', 'feedback'] as const;

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

/** An embeddings outage answers the MCP caller as `UNAVAILABLE`, any other failure as itself. */
async function orUnavailable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError) throw new Error(`UNAVAILABLE: ${err.message}`);
    throw err;
  }
}

const DESCRIPTION =
  `Project memory, the same service \`/api/memory\` serves. Actions: ${ACTIONS.join(' | ')}. ` +
  '`search` { query, topK?, sourceFilter?, strategy? }: semantic (default, cosine scores), keyword (Postgres FTS — exact identifiers, error codes) or hybrid (RRF fusion; scores are fused ranks). A semantic or hybrid search costs one embedding call (`embedMs`). When the question names an issue key, a status or a count, answer from the tracker (`forge issue …`) and do not search. Rows carrying `via` are one-hop neighbours of an issue hit (score 0, context, not matches); a hit with `stale: true` was superseded (`supersededBy`). Hits are point-in-time: each carries writtenAt, asOf (the date it speaks as of — cite it with that date, never as how things stand now), verifiedAt, staleRefs naming each issue or requirement it cites that no longer resolves, and cites linking every issue, requirement, commit and release it names (a key beside another project of the organization is read there; one placed in a project it does not name is unchecked). A flagged hit carries staleReason. `bookkeeping` rows are the upkeep records memory keeps of itself, written by core alone and returned only when sourceFilter names them. Verify, then report with `feedback`. ' +
  "`write` { source (any but bookkeeping), sourceRef, textContent, metadata? }: name another project's key as `<its slug> ISS-n`; upsert under (projectId, source, sourceRef) — the ref you name is the ref written, and a rewrite REPLACES its body (the old one stays readable at `GET /api/memory/revisions`). Answers {id, embeddedAt, truncated, degraded, nearDuplicateOf?, dedupeScore?}; nearDuplicateOf is advisory — refine that record by writing under its sourceRef. Agent-authored sources (note/knowledge/policy): textContent ≤8192 chars and no fenced code block over 5 lines. " +
  '`get` { source?, sourceRef?, metadataFilter?, includeArchived?, limit?, offset?, orderBy?, orderDir? }: natural-key lookup, no embedding; includeArchived also answers soft-deleted rows, each carrying archivedAt. ' +
  '`delete` { source, sourceRef }: idempotent, answers {deleted: the number of rows removed}. ' +
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
      await requireCan(
        actorFor(principal.userId),
        'project.read',
        projectResource(input.projectId),
      );
      return orUnavailable(() => runMemorySearch({ ...input, surface: 'agent' }));
    }

    if (action === 'get') {
      const input = getMemoryInputSchema.parse(rest);
      await requireCan(
        actorFor(principal.userId),
        'project.read',
        projectResource(input.projectId),
      );
      return runMemoryGet(input);
    }

    if (action === 'delete') {
      const input = deleteMemoryInputSchema.parse(rest);
      await requireCan(
        actorFor(principal.userId),
        'project.write',
        projectResource(input.projectId),
      );
      return { deleted: await deleteMemory(input.projectId, input.source, input.sourceRef) };
    }

    if (action === 'feedback') {
      const input = memoryFeedbackInputSchema.parse(rest);
      await requireCan(
        actorFor(principal.userId),
        'project.write',
        projectResource(input.projectId),
      );
      return await runMemoryFeedback(input);
    }

    const input = writeMemoryInputSchema.parse(rest);
    await requireCan(actorFor(principal.userId), 'project.write', projectResource(input.projectId));
    return runMemoryWrite(input, { writtenBy: principal.userId });
  },
});
