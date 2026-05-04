import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { jobs, runners } from '../../db/schema.js';
import {
  type DeviceScopedMcpToolFactory,
  assertDeviceOwnerIsMember,
  zodToMcpSchema,
} from './lib.js';

/**
 * `forge_pm.runner_load` (Epic 3, ISS-19) — per-runner status + in-flight
 * counter so the PM agent can decide where (or whether) to dispatch work.
 * `capacity` surfaces `capabilities.maxConcurrent` when the runner declares
 * it; `null` means "no declared cap, treat as elastic".
 */

const inputSchema = z.object({ projectId: z.uuid() }).strict();

const ACTIVE_JOB_STATUSES = ['dispatched', 'running'] as const;

export const forgePmRunnerLoadTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_pm.runner_load',
  description:
    'Per-runner status + in-flight job counter for a project. Read-only; requires project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, input.projectId);

    const runnerRows = await db
      .select({
        id: runners.id,
        type: runners.type,
        host: runners.host,
        status: runners.status,
        lastSeenAt: runners.lastSeenAt,
        capabilities: runners.capabilities,
      })
      .from(runners)
      .where(eq(runners.projectId, input.projectId))
      .orderBy(asc(runners.type), asc(runners.name));

    const out = await Promise.all(
      runnerRows.map(async (r) => {
        const [row] = await db
          .select({ n: count() })
          .from(jobs)
          .where(and(eq(jobs.runnerId, r.id), inArray(jobs.status, [...ACTIVE_JOB_STATUSES])));
        const caps = (r.capabilities ?? {}) as Record<string, unknown>;
        const rawCap = caps.maxConcurrent;
        const capacity = typeof rawCap === 'number' && Number.isFinite(rawCap) ? rawCap : null;
        return {
          id: r.id,
          type: r.type,
          host: r.host,
          status: r.status,
          lastSeenAt: r.lastSeenAt,
          capacity,
          inFlight: Number(row?.n ?? 0),
        };
      }),
    );

    return { runners: out };
  },
});
