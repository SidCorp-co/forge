import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { devices, runners } from '../../db/schema.js';
import {
  type ContextScopedMcpToolFactory,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['list', 'rename', 'revoke']),
    deviceId: z.uuid().optional(),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const forgeMyDevicesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_my_devices',
  description:
    "Owner-scoped CRUD over the principal's own paired devices. Mirrors GET /me/devices + PATCH/DELETE /devices/:id without requiring a browser JWT (no fresh-auth window — possession of the device token / PAT proves identity). Actions: `list` (no args), `rename { deviceId, name }`, `revoke { deviceId }` (soft delete: status=revoked + drop runner bindings).",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const userId = principalUserId(ctx.principal);

    if (input.action === 'list') {
      const rows = await db
        .select({
          id: devices.id,
          name: devices.name,
          platform: devices.platform,
          agentVersion: devices.agentVersion,
          status: devices.status,
          lastSeenAt: devices.lastSeenAt,
          pairedAt: devices.pairedAt,
          capabilities: devices.capabilities,
          createdAt: devices.createdAt,
        })
        .from(devices)
        .where(eq(devices.ownerId, userId))
        .orderBy(desc(devices.pairedAt));
      return { devices: rows };
    }

    if (input.action === 'rename') {
      if (!input.deviceId)
        throw new Error('BAD_REQUEST: deviceId is required for action=rename');
      if (!input.name)
        throw new Error('BAD_REQUEST: name is required for action=rename');
      const [existing] = await db
        .select({ ownerId: devices.ownerId })
        .from(devices)
        .where(eq(devices.id, input.deviceId))
        .limit(1);
      if (!existing) throw new Error('NOT_FOUND: device not found');
      if (existing.ownerId !== userId)
        throw new Error('FORBIDDEN: not the device owner');
      const [updated] = await db
        .update(devices)
        .set({ name: input.name })
        .where(eq(devices.id, input.deviceId))
        .returning({
          id: devices.id,
          name: devices.name,
          platform: devices.platform,
          status: devices.status,
          lastSeenAt: devices.lastSeenAt,
          pairedAt: devices.pairedAt,
        });
      if (!updated) throw new Error('NOT_FOUND: device not found');
      return { device: updated };
    }

    // revoke
    if (!input.deviceId)
      throw new Error('BAD_REQUEST: deviceId is required for action=revoke');
    const [existing] = await db
      .select({ ownerId: devices.ownerId, status: devices.status })
      .from(devices)
      .where(eq(devices.id, input.deviceId))
      .limit(1);
    if (!existing) throw new Error('NOT_FOUND: device not found');
    if (existing.ownerId !== userId)
      throw new Error('FORBIDDEN: not the device owner');
    const deviceId = input.deviceId;
    await db.transaction(async (tx) => {
      await tx
        .update(devices)
        .set({ status: 'revoked' })
        .where(eq(devices.id, deviceId));
      await tx.delete(runners).where(eq(runners.deviceId, deviceId));
    });
    return { device: { id: deviceId, status: 'revoked' as const } };
  },
});
