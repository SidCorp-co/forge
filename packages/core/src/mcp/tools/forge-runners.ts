import { z } from 'zod';
import {
  type RunnerStatus,
  type RunnerType,
  runnerHosts,
  runnerStatuses,
  type runners,
  runnerTypes,
} from '../../db/schema.js';
import { countInFlightByRunner, countInFlightForOneRunner } from '../../jobs/in-flight.js';
import {
  findRunnerProjectId,
  insertRunner,
  listRunners,
  setRunnerCapabilities,
  setRunnerStatus,
} from '../../runners/service.js';
import { runnerCapabilitiesSchema } from '../../runners/types.js';
import {
  assertPrincipalIsAdmin,
  type ContextScopedMcpToolFactory,
  loadVisibleProjectIdsForPrincipal,
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
    limitReason: r.limitReason,
    rateLimitedUntil: r.rateLimitedUntil,
    limitDetail: r.limitDetail,
    quarantinedUntil: r.quarantinedUntil,
    quarantineReason: r.quarantineReason,
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

export const forgeRunnersTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_runners',
  description:
    'Manage runners for projects in your scope (projects you own or are a member of). Actions: `list` (optional projectId/status/type filters, restricted to your projects; returns inFlightCount per runner plus quarantinedUntil/quarantineReason — non-null means the box is HARD-excluded from dispatch after repeated identical box-scoped failures, either the same preflight check or the same never-claimed dispatch; distinct from the rate/usage/auth limitReason fields), `register` (insert with default status=offline; requires owner/admin on the target project), `retire` (sets status=disabled; requires owner/admin; refuses with RUNNER_BUSY unless force:true), `update_capabilities` (replaces capabilities jsonb after server-side validation; requires owner/admin).',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);

    if (input.action === 'list') {
      const visibleIds = await loadVisibleProjectIdsForPrincipal(ctx.principal);
      if (visibleIds.length === 0) return { runners: [] };
      const rows = await listRunners({
        visibleProjectIds: visibleIds,
        projectId: input.projectId,
        status: input.status as RunnerStatus | undefined,
        type: input.type as RunnerType | undefined,
      });
      if (rows.length === 0) return { runners: [] };

      const inFlightMap = await countInFlightByRunner(rows.map((r) => r.id));
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
      await assertPrincipalIsAdmin(ctx.principal, input.data.projectId);
      const caps = parseCapabilitiesOrThrow(input.data.capabilities);
      const row = await insertRunner({
        projectId: input.data.projectId,
        type: input.data.type,
        host: input.data.host,
        deviceId: input.data.deviceId ?? null,
        name: input.data.name,
        labels: input.data.labels ?? [],
        capabilities: caps,
        config: input.data.config ?? {},
      });
      return { runner: publicRunnerRow(row) };
    }

    if (input.action === 'retire') {
      if (!input.runnerId) {
        throw new Error('BAD_REQUEST: runnerId is required for action=retire');
      }
      const runnerId = input.runnerId;
      const ownerProjectId = await findRunnerProjectId(runnerId);
      if (!ownerProjectId) throw new Error('NOT_FOUND: runner not found');
      await assertPrincipalIsAdmin(ctx.principal, ownerProjectId);
      const force = input.force ?? false;
      const inFlight = await countInFlightForOneRunner(runnerId);
      if (inFlight > 0 && !force) {
        throw new Error(
          `BAD_REQUEST: RUNNER_BUSY: runner has ${inFlight} in-flight job(s); pass force:true to override`,
        );
      }
      if (force && inFlight > 0) {
        await setRunnerStatus(runnerId, 'draining');
      }
      const row = await setRunnerStatus(runnerId, 'disabled');
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
    const ownerProjectId = await findRunnerProjectId(input.runnerId);
    if (!ownerProjectId) throw new Error('NOT_FOUND: runner not found');
    await assertPrincipalIsAdmin(ctx.principal, ownerProjectId);
    const caps = parseCapabilitiesOrThrow(input.capabilities);
    const row = await setRunnerCapabilities(input.runnerId, caps);
    if (!row) throw new Error('NOT_FOUND: runner not found');
    return { runner: publicRunnerRow(row) };
  },
});
