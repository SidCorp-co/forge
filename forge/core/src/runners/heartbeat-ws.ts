import { and, eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { db } from '../db/client.js';
import { runnerTypes, runners } from '../db/schema.js';
import { logger } from '../logger.js';
import { roomManager } from '../ws/server.js';
import { projectRoom, runnerRoom } from '../ws/rooms.js';

type DevicePrincipal = { type: 'device'; deviceId: string; ownerId: string };

interface RunnerWs extends WebSocket {
  principal?: { type: 'user' | 'device'; deviceId?: string; ownerId?: string; userId?: string };
}

const registerSchema = z
  .object({
    type: z.enum(runnerTypes),
    name: z.string().min(1).max(120),
    projectId: z.uuid(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    labels: z.array(z.string()).optional(),
  })
  .strict();

const unregisterSchema = z
  .object({
    runnerId: z.uuid().optional(),
    type: z.enum(runnerTypes).optional(),
  })
  .strict();

const updateSchema = z
  .object({
    runnerId: z.uuid(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    labels: z.array(z.string()).optional(),
    name: z.string().min(1).max(120).optional(),
  })
  .strict();

function devicePrincipal(ws: RunnerWs): DevicePrincipal | null {
  const p = ws.principal;
  if (!p || p.type !== 'device' || !p.deviceId || !p.ownerId) return null;
  return { type: 'device', deviceId: p.deviceId, ownerId: p.ownerId };
}

export async function handleRunnerRegister(ws: RunnerWs, msg: unknown): Promise<void> {
  const principal = devicePrincipal(ws);
  if (!principal) {
    logger.warn('runner:register from non-device principal');
    return;
  }
  const data = (msg as { data?: unknown })?.data;
  const parsed = registerSchema.safeParse(data);
  if (!parsed.success) {
    logger.warn({ err: parsed.error.message }, 'runner:register invalid payload');
    return;
  }
  const input = parsed.data;
  // Upsert by (deviceId, type).
  const [existing] = await db
    .select()
    .from(runners)
    .where(and(eq(runners.deviceId, principal.deviceId), eq(runners.type, input.type)))
    .limit(1);

  let runnerId: string;
  if (existing) {
    const [updated] = await db
      .update(runners)
      .set({
        projectId: input.projectId,
        name: input.name,
        labels: input.labels ?? (existing.labels as string[]),
        capabilities: input.capabilities ?? (existing.capabilities as Record<string, unknown>),
        ...(input.config ? { config: input.config } : {}),
        status: 'online',
        lastSeenAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(runners.id, existing.id))
      .returning({ id: runners.id });
    if (!updated) return;
    runnerId = updated.id;
  } else {
    try {
      const [inserted] = await db
        .insert(runners)
        .values({
          projectId: input.projectId,
          type: input.type,
          host: 'device',
          deviceId: principal.deviceId,
          name: input.name,
          labels: input.labels ?? [],
          capabilities: input.capabilities ?? {},
          config: input.config ?? {},
          status: 'online',
          lastSeenAt: new Date(),
        })
        .returning({ id: runners.id });
      if (!inserted) return;
      runnerId = inserted.id;
    } catch (err) {
      // Concurrent register from same device for same type — runners_device_type_uq
      // raced. Re-select the row that won.
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        const [retry] = await db
          .select()
          .from(runners)
          .where(and(eq(runners.deviceId, principal.deviceId), eq(runners.type, input.type)))
          .limit(1);
        if (!retry) return;
        runnerId = retry.id;
        await db
          .update(runners)
          .set({ status: 'online', lastSeenAt: new Date(), updatedAt: new Date() })
          .where(eq(runners.id, retry.id));
      } else {
        logger.error({ err }, 'runner:register insert threw');
        return;
      }
    }
  }

  roomManager.publish(projectRoom(input.projectId), {
    event: 'runner.status',
    data: { runnerId, status: 'online', deviceId: principal.deviceId, type: input.type },
  });
  roomManager.publish(runnerRoom(runnerId), {
    event: 'runner.status',
    data: { runnerId, status: 'online' },
  });
  // Echo back so the daemon learns its runnerId.
  try {
    ws.send(
      JSON.stringify({
        event: 'runner.registered',
        data: { runnerId, type: input.type },
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    // socket may have closed
  }
}

export async function handleRunnerUnregister(ws: RunnerWs, msg: unknown): Promise<void> {
  const principal = devicePrincipal(ws);
  if (!principal) return;
  const data = (msg as { data?: unknown })?.data;
  const parsed = unregisterSchema.safeParse(data ?? {});
  if (!parsed.success) return;
  const input = parsed.data;

  const filters = [eq(runners.deviceId, principal.deviceId)];
  if (input.runnerId) filters.push(eq(runners.id, input.runnerId));
  if (input.type) filters.push(eq(runners.type, input.type));
  const matched = await db
    .update(runners)
    .set({ status: 'offline', updatedAt: new Date() })
    .where(and(...filters))
    .returning({ id: runners.id, projectId: runners.projectId });
  for (const m of matched) {
    roomManager.publish(projectRoom(m.projectId), {
      event: 'runner.status',
      data: { runnerId: m.id, status: 'offline' },
    });
  }
}

export async function handleRunnerUpdate(ws: RunnerWs, msg: unknown): Promise<void> {
  const principal = devicePrincipal(ws);
  if (!principal) return;
  const data = (msg as { data?: unknown })?.data;
  const parsed = updateSchema.safeParse(data);
  if (!parsed.success) return;
  const input = parsed.data;
  const update: Record<string, unknown> = { lastSeenAt: new Date(), updatedAt: new Date() };
  if (input.capabilities) update['capabilities'] = input.capabilities;
  if (input.labels) update['labels'] = input.labels;
  if (input.name) update['name'] = input.name;
  await db
    .update(runners)
    .set(update)
    .where(and(eq(runners.id, input.runnerId), eq(runners.deviceId, principal.deviceId)));
}
