/**
 * ISS-217 — Action-dispatcher exposing project↔device runner binding over MCP.
 * The REST surface in `projects/routes.ts` (GET `/:id` devicePool slice,
 * POST `/:id/runners`, DELETE `/:id/runners/:runnerId`, PATCH `/:id`
 * `{ defaultDeviceId }`) is browser-only; orchestration agents that pair a
 * device via MCP previously had no way to self-provision a runner. This tool
 * closes that gap for the four runner-management operations.
 *
 * Action surface diverges intentionally from REST in one place: `remove`
 * accepts a `deviceId` (not a `runnerId`) — orchestration agents naturally
 * hold deviceIds. Resolution-to-runner happens inside the handler.
 *
 * Auth gates mirror REST exactly:
 *   - `list`            → project member        (PAT: `read`)
 *   - `add`             → owner-or-admin        (PAT: `write`)
 *   - `remove`          → owner-or-admin        (PAT: `write`)
 *   - `setDefault`      → owner-only            (PAT: `write`)
 *
 * `setDefault` additionally rejects a deviceId that isn't already in the
 * project's devicePool — the web flow always binds first via
 * `useRunnerToggle`, and silently persisting an orphan default would be a
 * foot-gun.
 */

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  devices,
  projectMembers,
  projects,
  runners,
} from '../../db/schema.js';
import { defaultRunnerCapabilities } from '../../runners/select.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsAdmin,
  assertPrincipalIsMember,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['list', 'add', 'remove', 'setDefault']),
    projectId: z.uuid(),
    deviceId: z.uuid().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const forgeProjectRunnersTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_project_runners',
  description:
    "Manage the project↔device runner pool (devicePool) over MCP. Actions: `list` (returns devicePool + defaultDeviceId; member-gated, PAT needs `read`), `add` (upsert a (project, device, 'claude-code') runner row; owner-or-admin, PAT needs `write`), `remove` (idempotent delete keyed on deviceId, not runnerId; owner-or-admin, PAT needs `write`), `setDefault` (set projects.defaultDeviceId; OWNER-ONLY — admin is insufficient, matches REST PATCH /api/projects/:id; PAT needs `write`; rejects with DEVICE_NOT_BOUND when deviceId is not in the project's devicePool).",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;

    if (input.action === 'list') {
      return handleList(input, principal);
    }
    if (input.action === 'add') {
      return handleAdd(input, principal);
    }
    if (input.action === 'remove') {
      return handleRemove(input, principal);
    }
    return handleSetDefault(input, principal);
  },
});

async function handleList(
  input: Input,
  principal: Parameters<typeof assertPrincipalIsMember>[0],
) {
  if (principal.kind === 'pat' && !principal.scopes.includes('read')) {
    throw new Error('FORBIDDEN_SCOPE: requires read scope on the PAT');
  }
  await assertPrincipalIsMember(principal, input.projectId);

  const devicePool = await db
    .select({
      id: devices.id,
      name: devices.name,
      platform: devices.platform,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      runnerId: runners.id,
    })
    .from(runners)
    .innerJoin(devices, eq(devices.id, runners.deviceId))
    .where(
      and(
        eq(runners.projectId, input.projectId),
        eq(runners.type, 'claude-code'),
        eq(runners.host, 'device'),
      ),
    );

  const [proj] = await db
    .select({ defaultDeviceId: projects.defaultDeviceId })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);

  return {
    devicePool,
    defaultDeviceId: proj?.defaultDeviceId ?? null,
  };
}

async function handleAdd(
  input: Input,
  principal: Parameters<typeof assertPrincipalIsAdmin>[0],
) {
  if (!input.deviceId) {
    throw new Error('BAD_REQUEST: deviceId is required for action=add');
  }
  if (principal.kind === 'pat' && !principal.scopes.includes('write')) {
    throw new Error('FORBIDDEN_SCOPE: requires write scope on the PAT');
  }
  await assertPrincipalIsAdmin(principal, input.projectId);

  const [device] = await db
    .select({
      id: devices.id,
      name: devices.name,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(devices)
    .where(eq(devices.id, input.deviceId))
    .limit(1);
  if (!device) throw new Error('NOT_FOUND: DEVICE_NOT_FOUND');

  const status: 'online' | 'offline' =
    device.status === 'online' && device.lastSeenAt ? 'online' : 'offline';

  const [runner] = await db
    .insert(runners)
    .values({
      projectId: input.projectId,
      type: 'claude-code',
      host: 'device',
      deviceId: input.deviceId,
      name: device.name,
      capabilities: defaultRunnerCapabilities('claude-code', input.capabilities),
      status,
    })
    .onConflictDoUpdate({
      target: [runners.projectId, runners.deviceId, runners.type],
      targetWhere: sql`device_id IS NOT NULL`,
      set: {
        status,
        updatedAt: new Date(),
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      },
    })
    .returning({
      id: runners.id,
      projectId: runners.projectId,
      deviceId: runners.deviceId,
      status: runners.status,
    });
  if (!runner) throw new Error('runners: insert returned no row');

  return { runner };
}

async function handleRemove(
  input: Input,
  principal: Parameters<typeof assertPrincipalIsAdmin>[0],
) {
  if (!input.deviceId) {
    throw new Error('BAD_REQUEST: deviceId is required for action=remove');
  }
  if (principal.kind === 'pat' && !principal.scopes.includes('write')) {
    throw new Error('FORBIDDEN_SCOPE: requires write scope on the PAT');
  }
  await assertPrincipalIsAdmin(principal, input.projectId);

  // Idempotent — return ok regardless of whether a row was deleted, matching
  // REST DELETE /api/projects/:id/runners/:runnerId (204 on miss).
  await db
    .delete(runners)
    .where(
      and(
        eq(runners.projectId, input.projectId),
        eq(runners.deviceId, input.deviceId),
        eq(runners.type, 'claude-code'),
        eq(runners.host, 'device'),
      ),
    );
  return { ok: true };
}

async function handleSetDefault(
  input: Input,
  principal: Parameters<typeof assertPrincipalIsMember>[0],
) {
  if (!input.deviceId) {
    throw new Error('BAD_REQUEST: deviceId is required for action=setDefault');
  }
  if (principal.kind === 'pat' && !principal.scopes.includes('write')) {
    throw new Error('FORBIDDEN_SCOPE: requires write scope on the PAT');
  }
  // Owner-only gate — mirror forge_projects.update (admin role insufficient).
  // PAT allowlist is enforced upstream by the server (returns NOT_FOUND); we
  // still re-check here so a direct handler test surfaces the same error.
  if (
    principal.kind === 'pat' &&
    principal.projectIds !== null &&
    !principal.projectIds.includes(input.projectId)
  ) {
    throw new Error('NOT_FOUND: project not found or not accessible');
  }

  const userId = principalUserId(principal);
  const [proj] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!proj) throw new Error('NOT_FOUND: project not found or not accessible');

  if (proj.ownerId !== userId) {
    const [member] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!member) throw new Error('NOT_FOUND: project not found or not accessible');
    if (member.role !== 'owner') {
      throw new Error('FORBIDDEN: requires project owner (admin role is insufficient)');
    }
  }

  // Reject orphan defaults — the deviceId must already be bound as a
  // claude-code/device runner on the project. Matches the web flow's
  // bind-first-then-default contract.
  const [binding] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(
      and(
        eq(runners.projectId, input.projectId),
        eq(runners.deviceId, input.deviceId),
        eq(runners.type, 'claude-code'),
        eq(runners.host, 'device'),
      ),
    )
    .limit(1);
  if (!binding) {
    throw new Error('BAD_REQUEST: DEVICE_NOT_BOUND: device is not in the project devicePool');
  }

  const [updated] = await db
    .update(projects)
    .set({ defaultDeviceId: input.deviceId })
    .where(eq(projects.id, input.projectId))
    .returning({
      id: projects.id,
      defaultDeviceId: projects.defaultDeviceId,
    });
  if (!updated) throw new Error('NOT_FOUND: project not found');

  return { project: updated };
}
