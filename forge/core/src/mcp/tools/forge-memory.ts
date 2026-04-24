import { z } from 'zod';
import { memorySources } from '../../db/schema.js';
import { EmbeddingUnavailableError } from '../../embeddings/index.js';
import { runMemorySearch } from '../../memory/search-service.js';
import { assertDeviceOwnerIsMember, zodToMcpSchema } from './lib.js';
import type { DeviceScopedMcpToolFactory } from './lib.js';

const inputSchema = z.object({
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
    'Semantic search over project memory (issues, comments, jobs, notes, knowledge). Requires the authenticated device owner to be a member of the given projectId.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
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
