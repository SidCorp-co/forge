import { z } from 'zod';
import pkg from '../../../package.json' with { type: 'json' };
import { countActiveJobs, readLiveness } from '../../health/service.js';
import { getLastSeedResult } from '../../skills/builtin-seed.js';
import { type DeviceScopedMcpToolFactory, zodToMcpSchema } from './lib.js';

/**
 * MCP Phase 1 (ISS-7) — server snapshot for "is the core healthy?" calls
 * from MCP clients. No project scope: the /mcp endpoint is already gated by
 * `requireDevice()` so a valid device-token is sufficient. Wraps the same
 * three checks as `app.get('/health')` plus seed status and active-jobs
 * counter so a Claude session can self-diagnose without tailing server log.
 */

const inputSchema = z.object({}).strict();

export const forgeHealthTool: DeviceScopedMcpToolFactory = (_device) => ({
  name: 'forge_health',
  description:
    'Server snapshot: version, uptime, db/queue/ws status, last builtin-skills seed result, and active jobs count. Device-token only (no project scope).',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    inputSchema.parse(args);

    const live = await readLiveness();
    const dbOk = live.dbOk;
    const jobsActive = dbOk ? await countActiveJobs() : 0;

    const seed = getLastSeedResult();
    const lastSeed = seed
      ? {
          inserted: seed.inserted,
          updated: seed.updated,
          unchanged: seed.unchanged,
          // Serialise to ISO so MCP callers see a stable string regardless of
          // transport (structuredContent forwards the raw value; consumers
          // that rely on the JSON `content` field also get the ISO form).
          at: seed.at.toISOString(),
        }
      : null;

    return {
      version: pkg.version,
      uptimeSeconds: Math.floor(process.uptime()),
      db: dbOk ? 'ok' : 'down',
      queue: live.queueOk ? 'ok' : 'down',
      ws: live.wsOk ? 'ok' : 'down',
      lastSeed,
      jobsActive,
    };
  },
});
