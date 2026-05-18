import { type SQL, and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  type RunnerStatus,
  type RunnerType,
  jobs,
  runnerHosts,
  runnerStatuses,
  runnerTypes,
  runners,
} from '../../db/schema.js';
import { countInFlightForRunner } from '../../jobs/dispatch-gates.js';
import { runnerCapabilitiesSchema } from '../../runners/types.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalCanAdmin,
  zodToMcpSchema,
} from './lib.js';

const registerDataSchema = z
  .object({
    projectId: z.uuid(),
    type: z.enum(runnerTypes),
    host: z.enum(runnerHosts),
    deviceId: z.uuid().optional(),
    name: z.string().trim().min(1).max(120),
    labels: z.array(z.string()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    action: z.enum(['list', 'register', 'retire', 'update_capabilities']),
    // list filters
    projectId: z.uuid().optional(),
    status: z.enum(runnerStatuses).optional(),
    type: z.enum(runnerTypes).optional(),
    // register
    data: registerDataSchema.optional(),
    // retire / update_capabilities
    runnerId: z.uuid().optional(),
    force: z.boolean().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function publicRunnerRow(r: typeof runners.$inferSelect) {
  const cfg = { ...((r.config ?? {}) as Record<string, unknown>) };
  if ('apiKey' in cfg) cfg.apiKey = '***';
  if ('callbackSecret' in cfg) cfg.callbackSecret = '***';
  return {
    id: r.id,
    projectId: r.projectId,
    type: r.type,
    host: r.host,
    deviceId: r.deviceId,
    name: r.name,
    labels: Array.isArray(r.labels) ? (r.labels as string[]) : [],
    capabilities: (r.capabilities ?? {}) as Record<string, unknown>,
    config: cfg,
    status: r.status,
    lastSeenAt: r.lastSeenAt,
    lastError: r.lastError,
  };
}

function parseCapabilitiesOrThrow(input: unknown): Record<string, unknown> {
  const parsed = runnerCapabilitiesSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path?.join('.') ?? '<root>';
    throw new Error(`BAD_REQUEST: INVALID_CAPABILITIES: ${path}: ${first?.message ?? 'invalid'}`);
  }
  return parsed.data as Record<string, unknown>;
}

export const forgeAdminRunnersTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_admin_runners',
  description:
    "Cross-tenant runner administration. Requires system admin (`users.isCeo=true`) AND PAT scope `admin` (device tokens are exempt). Actions: `list` (optional projectId/status/type filters; returns inFlightCount per runner), `register` (insert with default status=offline), `retire` (sets status=disabled; refuses with RUNNER_BUSY unless force:true), `update_capabilities` (replaces capabilities jsonb after server-side validation).",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertPrincipalCanAdmin(ctx.principal);

    if (input.action === 'list') {
      const filters: SQL[] = [];
      if (input.projectId) filters.push(eq(runners.projectId, input.projectId));
      if (input.status) filters.push(eq(runners.status, input.status as RunnerStatus));
      if (input.type) filters.push(eq(runners.type, input.type as RunnerType));
      const rows = await db
        .select()
        .from(runners)
        .where(filters.length > 0 ? and(...filters) : undefined);
      if (rows.length === 0) return { runners: [] };

      const inFlightRows = await db
        .select({ runnerId: jobs.runnerId, n: sql<number>`count(*)::int` })
        .from(jobs)
        .where(
          and(
            inArray(
              jobs.runnerId,
              rows.map((r) => r.id),
            ),
            inArray(jobs.status, ['dispatched', 'running']),
          ),
        )
        .groupBy(jobs.runnerId);
      const inFlightMap = new Map(
        inFlightRows.map((r) => [r.runnerId ?? '', Number(r.n ?? 0)]),
      );
      return {
        runners: rows.map((r) => ({
          ...publicRunnerRow(r),
          inFlightCount: inFlightMap.get(r.id) ?? 0,
        })),
      };
    }

    if (input.action === 'register') {
      if (!input.data) {
        throw new Error('BAD_REQUEST: data is required for action=register');
      }
      const caps = parseCapabilitiesOrThrow(input.data.capabilities);
      const [row] = await db
        .insert(runners)
        .values({
          projectId: input.data.projectId,
          type: input.data.type,
          host: input.data.host,
          deviceId: input.data.deviceId ?? null,
          name: input.data.name,
          labels: input.data.labels ?? [],
          capabilities: caps,
          config: input.data.config ?? {},
          status: 'offline',
        })
        .returning();
      if (!row) throw new Error('runners: insert returned no row');
      return { runner: publicRunnerRow(row) };
    }

    if (input.action === 'retire') {
      if (!input.runnerId) {
        throw new Error('BAD_REQUEST: runnerId is required for action=retire');
      }
      const runnerId = input.runnerId;
      const force = input.force ?? false;
      const inFlight = await countInFlightForRunner(runnerId);
      if (inFlight > 0 && !force) {
        throw new Error(
          `BAD_REQUEST: RUNNER_BUSY: runner has ${inFlight} in-flight job(s); pass force:true to override`,
        );
      }
      if (force && inFlight > 0) {
        await db
          .update(runners)
          .set({ status: 'draining', updatedAt: new Date() })
          .where(eq(runners.id, runnerId));
      }
      const [row] = await db
        .update(runners)
        .set({ status: 'disabled', updatedAt: new Date() })
        .where(eq(runners.id, runnerId))
        .returning();
      if (!row) throw new Error('NOT_FOUND: runner not found');
      return { runner: publicRunnerRow(row) };
    }

    // update_capabilities
    if (!input.runnerId) {
      throw new Error('BAD_REQUEST: runnerId is required for action=update_capabilities');
    }
    if (input.capabilities === undefined) {
      throw new Error('BAD_REQUEST: capabilities is required for action=update_capabilities');
    }
    const caps = parseCapabilitiesOrThrow(input.capabilities);
    const [row] = await db
      .update(runners)
      .set({ capabilities: caps, updatedAt: new Date() })
      .where(eq(runners.id, input.runnerId))
      .returning();
    if (!row) throw new Error('NOT_FOUND: runner not found');
    return { runner: publicRunnerRow(row) };
  },
});
