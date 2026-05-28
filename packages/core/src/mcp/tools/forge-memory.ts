import { z } from 'zod';
import { memorySources } from '../../db/schema.js';
import { EmbeddingUnavailableError } from '../../embeddings/index.js';
import { getMemoryInputSchema, runMemoryGet } from '../../memory/get-service.js';
import { deleteMemory } from '../../memory/indexer.js';
import { runMemorySearch } from '../../memory/search-service.js';
import { runMemoryWrite, writeMemoryInputSchema } from '../../memory/write-service.js';
import { assertDeviceOwnerIsMember, zodToMcpSchema } from './lib.js';
import type { DeviceScopedMcpToolFactory } from './lib.js';

const deleteInputSchema = z.object({
  projectId: z.uuid(),
  source: z.enum(memorySources),
  sourceRef: z.string().trim().min(1).max(512),
});

const searchInputSchema = z.object({
  projectId: z.uuid(),
  query: z.string().trim().min(1).max(4000),
  // Match REST default so MCP callers omitting topK get the same 10 hits.
  topK: z.number().int().min(1).max(50).default(10),
  sourceFilter: z.array(z.enum(memorySources)).optional(),
});

/**
 * `forge_memory.search` — semantic memory query via MCP. Wraps the same
 * service function used by `POST /api/memory/search` (ISS-198) so the
 * response shape is identical across REST and MCP.
 */
export const forgeMemorySearchTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_memory.search',
  description:
    'Semantic search over project memory (issues, comments, jobs, notes, knowledge, decisions, policies). Step handoffs live in their own table — use `forge_step_handoff.get` for those. Requires the authenticated device owner to be a member of the given projectId.',
  inputSchema: zodToMcpSchema(searchInputSchema),
  handler: async (args) => {
    const input = searchInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, input.projectId);
    try {
      return await runMemorySearch(input);
    } catch (err) {
      // Surface embeddings outage with a stable prefix so MCP callers can
      // recognise it (mirrors REST's 503 EMBEDDING_UNAVAILABLE response).
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
export const forgeMemoryGetTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_memory.get',
  description:
    'List memory rows for a project, filtered by source / sourceRef / metadata containment. Returns rows sorted by createdAt|updatedAt|embeddedAt + a total count. Does NOT embed — use for natural-key lookups (e.g. step handoff by run_id+step+attempt). Requires the device owner to be a project member.',
  inputSchema: zodToMcpSchema(getMemoryInputSchema),
  handler: async (args) => {
    const input = getMemoryInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, input.projectId);
    return runMemoryGet(input);
  },
});

/**
 * `forge_memory.delete` — remove a memory row by its natural key. Idempotent:
 * succeeds and returns `{deleted: false}` when no row matches. Equivalent to
 * REST `DELETE /api/memory/by-source?...` but accessible to device principals.
 */
export const forgeMemoryDeleteTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_memory.delete',
  description:
    'Delete a memory row by (projectId, source, sourceRef). Idempotent — returns {deleted:false} when no row matches. Requires the device owner to be a project member.',
  inputSchema: zodToMcpSchema(deleteInputSchema),
  handler: async (args) => {
    const input = deleteInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, input.projectId);
    const removed = await deleteMemory(input.projectId, input.source, input.sourceRef);
    return { deleted: removed > 0 };
  },
});

/**
 * `forge_memory.write` — upsert a memory row with embedding. Used by agents
 * to record step handoffs, decisions, notes, etc. Wraps the same service
 * function as `POST /api/memory` so REST + MCP behave identically.
 */
export const forgeMemoryWriteTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_memory.write',
  description:
    'Write (upsert) a memory row for a project. Embeds textContent via the configured embedding model and stores under the unique key (projectId, source, sourceRef). Returns {id, embeddedAt, truncated}. Requires the device owner to be a project member.',
  inputSchema: zodToMcpSchema(writeMemoryInputSchema),
  handler: async (args) => {
    const input = writeMemoryInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, input.projectId);
    try {
      return await runMemoryWrite(input);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        throw new Error(`UNAVAILABLE: ${err.message}`);
      }
      throw err;
    }
  },
});
