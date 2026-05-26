/**
 * `forge_pm.runner_load` (Epic 3, ISS-19) — per-runner status + in-flight
 * counter so the PM agent can decide where (or whether) to dispatch work.
 *
 * ISS-232 Phase 4 — runner cap is fixed at 1 across all types. The PM
 * tool surfaces `capacity: 1` for every row regardless of the legacy
 * `capabilities.maxConcurrent` field (which the dispatcher no longer
 * consults). Existing rows in the wild keep their stored value untouched
 * but the field is ignored end-to-end.
 *
 * ISS-145: handler body extracted into `pmRunnerLoadHandler` and consumed
 * by both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 *
 * TODO ISS-145-followup: remove the legacy shim factory after the
 * deprecation window closes.
 */

import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { db } from '../../db/client.js';
import { jobs, runners } from '../../db/schema.js';
import { RUNNER_CAP_PER_RUNNER } from '../../jobs/dispatch-gates.js';
import { deprecationFor } from '../deprecation.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  assertDeviceOwnerIsMember,
  zodToMcpSchema,
} from './lib.js';

export const pmRunnerLoadInputSchema = z.object({ projectId: z.uuid() }).strict();

const ACTIVE_JOB_STATUSES = ['dispatched', 'running'] as const;

export async function pmRunnerLoadHandler(
  device: Device,
  input: z.infer<typeof pmRunnerLoadInputSchema>,
) {
  await assertDeviceOwnerIsMember(device, input.projectId);

  const runnerRows = await db
    .select({
      id: runners.id,
      type: runners.type,
      host: runners.host,
      status: runners.status,
      lastSeenAt: runners.lastSeenAt,
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
      return {
        id: r.id,
        type: r.type,
        host: r.host,
        status: r.status,
        lastSeenAt: r.lastSeenAt,
        // ISS-232 Phase 4 — cap is uniform across runner types.
        capacity: RUNNER_CAP_PER_RUNNER,
        inFlight: Number(row?.n ?? 0),
      };
    }),
  );

  return { runners: out };
}

function recordDeprecation(ctx: McpContext, toolName: string) {
  if (deprecationFor(toolName) && ctx.deprecations) ctx.deprecations.add(toolName);
}

export const forgePmRunnerLoadTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pm.runner_load',
  description:
    '[DEPRECATED — use forge_project_pm (action=runner_load)] Per-runner status + in-flight job counter for a project. Read-only; requires project membership.',
  inputSchema: zodToMcpSchema(pmRunnerLoadInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.runner_load');
    const input = pmRunnerLoadInputSchema.parse(args);
    return pmRunnerLoadHandler(ctx.device, input);
  },
});
