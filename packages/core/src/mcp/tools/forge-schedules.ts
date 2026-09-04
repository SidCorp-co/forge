import { z } from 'zod';
import { listImprovementMessages } from '../../schedules/messages/registry.js';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listScheduleRuns,
  listSchedulesForMcp,
  readScheduleProjectId,
  runScheduleNow,
  updateSchedule,
} from '../../schedules/service.js';
import {
  assertPrincipalIsAdmin,
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';

// REST uses viewer for read, but member is the lowest MCP gate available
// (assertPrincipalIsMember); viewer-only PAT callers are not a supported
// MCP persona so member is an acceptable tightening for the MCP surface.
const scheduleMode = z.enum(['propose', 'auto']);
// ISS-618 — 'script' runs a standalone sandboxed Node.js script, no agent/LLM.
const apiScheduleKind = z.enum(['prompt', 'script']);

const inputSchema = z
  .object({
    action: z.enum(['list', 'get', 'runs', 'create', 'update', 'delete', 'run', 'catalog']),
    // project-scoped args
    projectId: z.uuid().optional(),
    enabled: z.boolean().optional(),
    // schedule-id args
    scheduleId: z.uuid().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    // create fields
    name: z.string().trim().min(1).max(200).optional(),
    cron: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1).max(20_000).optional(),
    kind: apiScheduleKind.optional(),
    script: z.string().trim().min(1).max(50_000).optional(),
    targetProjectSlug: z.string().trim().min(1).max(200).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    templateKey: z.string().trim().min(1).max(200).nullable().optional(),
    params: z.record(z.string(), z.unknown()).nullable().optional(),
    mode: scheduleMode.optional(),
  })
  .strict();

export const forgeSchedulesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_schedules',
  description:
    'Manage improvement schedules for a project. action=list/get/runs/create/update/delete/run/catalog. ' +
    'Requires device or PAT principal. Gate: list/get/runs/catalog → member; create/update/delete → admin; run → writer. ' +
    'list returns a body-free projection (no prompt/script field) to stay under the MCP output cap. ' +
    'catalog returns the full improvement-message registry (static list, no prompt 20k). ' +
    "kind='script' runs a standalone sandboxed Node.js script (ctx.log/ctx.http.fetch/ctx.notify/ctx.params) " +
    'on the cron cadence with no agent session and no Claude session — pass `script` instead of `prompt`/`templateKey`. ' +
    'Mirrors REST /api/schedules but accepts device/PAT principals without a user JWT.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;
    const userId = principalUserId(principal);

    switch (input.action) {
      case 'list': {
        if (!input.projectId) throw new Error('BAD_REQUEST: projectId is required for action=list');
        await assertPrincipalIsMember(principal, input.projectId);
        const rows = await listSchedulesForMcp(input.projectId, input.enabled);
        return { schedules: rows };
      }

      case 'get': {
        if (!input.scheduleId)
          throw new Error('BAD_REQUEST: scheduleId is required for action=get');
        const projectId = await readScheduleProjectId(input.scheduleId);
        await assertPrincipalIsMember(principal, projectId);
        const row = await getSchedule(input.scheduleId, userId);
        return { schedule: row };
      }

      case 'runs': {
        if (!input.scheduleId)
          throw new Error('BAD_REQUEST: scheduleId is required for action=runs');
        const projectId = await readScheduleProjectId(input.scheduleId);
        await assertPrincipalIsMember(principal, projectId);
        return listScheduleRuns(input.scheduleId, userId, input.limit);
      }

      case 'create': {
        if (!input.projectId)
          throw new Error('BAD_REQUEST: projectId is required for action=create');
        if (!input.name) throw new Error('BAD_REQUEST: name is required for action=create');
        if (!input.cron) throw new Error('BAD_REQUEST: cron is required for action=create');
        const kind = input.kind ?? 'prompt';
        if (kind === 'script' && !input.script) {
          throw new Error('BAD_REQUEST: script is required for action=create when kind="script"');
        }
        if (kind === 'prompt' && !input.prompt) {
          throw new Error('BAD_REQUEST: prompt is required for action=create when kind="prompt"');
        }
        await assertPrincipalIsAdmin(principal, input.projectId);
        const inserted = await createSchedule(
          {
            projectId: input.projectId,
            name: input.name,
            cron: input.cron,
            prompt: input.prompt,
            kind: input.kind,
            script: input.script,
            enabled: input.enabled,
            targetProjectSlug: input.targetProjectSlug,
            metadata: input.metadata,
            templateKey: input.templateKey,
            params: input.params,
            mode: input.mode,
          },
          userId,
        );
        return { schedule: inserted };
      }

      case 'update': {
        if (!input.scheduleId)
          throw new Error('BAD_REQUEST: scheduleId is required for action=update');
        const projectId = await readScheduleProjectId(input.scheduleId);
        await assertPrincipalIsAdmin(principal, projectId);
        const updated = await updateSchedule(
          input.scheduleId,
          {
            name: input.name,
            cron: input.cron,
            prompt: input.prompt,
            kind: input.kind,
            script: input.script,
            enabled: input.enabled,
            targetProjectSlug: input.targetProjectSlug,
            metadata: input.metadata,
            templateKey: input.templateKey,
            params: input.params,
            mode: input.mode,
          },
          userId,
        );
        return { schedule: updated };
      }

      case 'delete': {
        if (!input.scheduleId)
          throw new Error('BAD_REQUEST: scheduleId is required for action=delete');
        const projectId = await readScheduleProjectId(input.scheduleId);
        await assertPrincipalIsAdmin(principal, projectId);
        await deleteSchedule(input.scheduleId, userId);
        return { deleted: true };
      }

      case 'run': {
        if (!input.scheduleId)
          throw new Error('BAD_REQUEST: scheduleId is required for action=run');
        const projectId = await readScheduleProjectId(input.scheduleId);
        await assertPrincipalIsWriter(principal, projectId);
        return runScheduleNow(input.scheduleId, userId);
      }

      case 'catalog': {
        if (!input.projectId)
          throw new Error('BAD_REQUEST: projectId is required for action=catalog');
        await assertPrincipalIsMember(principal, input.projectId);
        return { messages: listImprovementMessages() };
      }

      default: {
        const _exhaustive: never = input.action;
        throw new Error(`BAD_REQUEST: unknown action ${_exhaustive}`);
      }
    }
  },
});
