import { z } from 'zod';
import { memorySources } from '../../db/schema.js';
import { EmbeddingUnavailableError } from '../../embeddings/index.js';
import {
  MemoryFeedbackValidationError,
  memoryFeedbackInputSchema,
  runMemoryFeedback,
} from '../../memory/feedback-service.js';
import { getMemoryInputSchema, runMemoryGet } from '../../memory/get-service.js';
import { deleteMemory } from '../../memory/indexer.js';
import { memorySearchStrategies, runMemorySearch } from '../../memory/search-service.js';
import {
  MemoryWriteValidationError,
  runMemoryWrite,
  writeMemoryInputSchema,
} from '../../memory/write-service.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  zodToMcpSchema,
} from './lib.js';

const deleteInputSchema = z.object({
  projectId: z.uuid(),
  source: z.enum(memorySources),
  sourceRef: z.string().trim().min(1).max(512),
});

const searchInputSchema = z.object({
  projectId: z.uuid(),
  query: z.string().trim().min(1).max(4000),
  // cm:edge contract -> packages/core/src/memory/search-routes.ts — the two surfaces declare this schema separately and nothing type-checks one against the other, so `topK` and `strategy` must be changed in both AND forwarded in both: that route declared `strategy` and then did not pass it to `runMemorySearch` for as long as it existed, so a REST caller asking for `hybrid` was answered `semantic` and told so in the response (fixed 2026-09-06, ISS-894). `semantic` is the default on both because its scores are cosine similarity and the prompt-facts thresholds (knowledge dedup > 0.8) are calibrated on that scale.
  topK: z.number().int().min(1).max(50).default(10),
  sourceFilter: z.array(z.enum(memorySources)).optional(),
  strategy: z.enum(memorySearchStrategies).default('semantic'),
});

/**
 * `forge_memory.search` — semantic memory query via MCP. Wraps the same
 * service function used by `POST /api/memory/search` (ISS-198) so the
 * response shape is identical across REST and MCP.
 */
export const forgeMemorySearchTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_memory.search',
  description:
    'Search project memory (issues, comments, jobs, notes, knowledge, decisions, policies). strategy: "semantic" (default, cosine-similarity scores), "keyword" (Postgres FTS — exact identifiers, error codes), or "hybrid" (RRF fusion of both; scores are fused ranks, not similarity). On a project whose admin turned on rerank, a hybrid result may come back `reranked: true` — read hits in list order (`rerankPosition`), not by `score`. On a project with relation expansion on, rows carrying `via` are one-hop dependency neighbours of an issue hit, appended after the ranked hits with score 0 — context, not matches. Hits are point-in-time: verify against live code before acting, then report the outcome via `forge_memory.feedback` (confirmed|outdated) — that write-back is how stale memory gets cleaned instead of waiting on slow usage decay. Step handoffs live in their own table — use `forge_step_handoff.get` for those. Requires the caller to be a member of the given projectId.',
  inputSchema: zodToMcpSchema(searchInputSchema),
  handler: async (args) => {
    const input = searchInputSchema.parse(args);
    await assertPrincipalIsMember(principal, input.projectId);
    try {
      return await runMemorySearch({ ...input, surface: 'agent' });
    } catch (err) {
      // cm:edge contract -> packages/core/src/memory/search-routes.ts — an MCP result has no status code, so this `UNAVAILABLE:` prefix is the whole signal a caller matches on; it is this file's stand-in for the 503 `EMBEDDING_UNAVAILABLE` that route throws, and rewording it breaks every caller that tells an outage from a bad query.
      if (err instanceof EmbeddingUnavailableError) {
        throw new Error(`UNAVAILABLE: ${err.message}`);
      }
      throw err;
    }
  },
});

/**
 * `forge_memory.get` — direct (non-semantic) memory query. Filters by source,
 * sourceRef exact, and JSONB metadata containment. Use for "fetch this
 * specific handoff" or "list all handoffs for run X" type queries — not for
 * similarity search (use `forge_memory.search`).
 */
export const forgeMemoryGetTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_memory.get',
  description:
    'List memory rows for a project, filtered by source / sourceRef / metadata containment. Returns rows sorted by createdAt|updatedAt|embeddedAt + a total count. Does NOT embed — use for natural-key lookups (e.g. step handoff by run_id+step+attempt). Live rows only unless includeArchived:true, which also returns soft-deleted rows (decay, consolidation, feedback verdict=outdated, and pre-ISS-876 `<ref>__superseded-<timestamp>` dedup snapshots) — every row carries archivedAt so an archived one is never mistaken for current memory. Requires project membership.',
  inputSchema: zodToMcpSchema(getMemoryInputSchema),
  handler: async (args) => {
    const input = getMemoryInputSchema.parse(args);
    await assertPrincipalIsMember(principal, input.projectId);
    return runMemoryGet(input);
  },
});

/**
 * `forge_memory.delete` — remove a memory row by its natural key. Idempotent:
 * succeeds and returns `{deleted: false}` when no row matches. Equivalent to
 * REST `DELETE /api/memory/by-source?...` in tool form.
 */
export const forgeMemoryDeleteTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_memory.delete',
  description:
    'Delete a memory row by (projectId, source, sourceRef). Idempotent — returns {deleted:false} when no row matches. Requires project membership.',
  inputSchema: zodToMcpSchema(deleteInputSchema),
  handler: async (args) => {
    const input = deleteInputSchema.parse(args);
    await assertPrincipalIsWriter(principal, input.projectId);
    const removed = await deleteMemory(input.projectId, input.source, input.sourceRef);
    return { deleted: removed > 0 };
  },
});

/**
 * `forge_memory.write` — upsert a memory row with embedding. Used by agents
 * to record step handoffs, decisions, notes, etc. Wraps the same service
 * function as `POST /api/memory` so REST + MCP behave identically.
 */
/**
 * `forge_memory.feedback` — recall-feedback loop (ISS-603). The write-back
 * half of "verify hits against live code before trusting": a confirmed
 * verification protects the row from usage decay, a disproved one archives
 * it immediately instead of letting it stay searchable for months.
 */
export const forgeMemoryFeedbackTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_memory.feedback',
  description:
    'Report the outcome of verifying a memory row against live code/state. verdict=confirmed stamps last_verified_at (protects the row from usage decay); verdict=outdated archives the row immediately (evidence required — what disproved it; a fresh write to the same sourceRef revives it). Agent-curated sources only (note/knowledge) — lifecycle mirrors track their source records. Call after acting on a forge_memory.search hit. Requires project write access.',
  inputSchema: zodToMcpSchema(memoryFeedbackInputSchema),
  handler: async (args) => {
    const input = memoryFeedbackInputSchema.parse(args);
    await assertPrincipalIsWriter(principal, input.projectId);
    try {
      return await runMemoryFeedback(input);
    } catch (err) {
      if (err instanceof MemoryFeedbackValidationError) {
        throw new Error(`INVALID: ${err.message}`);
      }
      throw err;
    }
  },
});

export const forgeMemoryWriteTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_memory.write',
  description:
    'Write (upsert) a memory row for a project. Embeds textContent via the configured embedding model and stores under the unique key (projectId, source, sourceRef) — the ref you name is ALWAYS the ref that is written, and no other row is ever modified. Re-writing an existing ref REPLACES its body; the body you replaced is kept and readable via `GET /api/memory/revisions`. Returns {id, embeddedAt, truncated, degraded, nearDuplicateOf?, dedupeScore?}. nearDuplicateOf is advisory: for note/knowledge, an existing row whose text is near-identical to yours, reported so you can decide to refine THAT record instead — to do so, re-issue the write under that exact sourceRef. degraded:true means embeddings were down and the row is keyword-searchable only until the backfill re-embeds it. Agent-authored sources (note/knowledge/policy) are quality-gated: textContent ≤8192 chars (the embedding window) and no fenced code block >5 lines — write the invariant + a file:line/SHA pointer instead of code; one-line runnable commands are fine. Requires project membership.',
  inputSchema: zodToMcpSchema(writeMemoryInputSchema),
  handler: async (args) => {
    const input = writeMemoryInputSchema.parse(args);
    await assertPrincipalIsWriter(principal, input.projectId);
    try {
      return await runMemoryWrite(input);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        throw new Error(`UNAVAILABLE: ${err.message}`);
      }
      if (err instanceof MemoryWriteValidationError) {
        throw new Error(`INVALID: ${err.message}`);
      }
      throw err;
    }
  },
});
