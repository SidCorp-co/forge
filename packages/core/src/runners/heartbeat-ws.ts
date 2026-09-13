import { and, eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { db } from '../db/client.js';
import { runners, runnerTypes } from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';
import { roomManager } from '../ws/room-manager.js';
import { projectRoom, runnerRoom } from '../ws/rooms.js';
import { defaultRunnerCapabilities } from './select.js';

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
  // cm:guard the upsert key is (project, device, type) — `runners_project_device_type_uq` in db/schema.ts is the authority, and a device may serve several projects. Keyed on device and type alone this UPDATE re-pointed an existing row's `project_id`, so the second of the daemon's per-project registers silently moved the first project's runner onto the second (ISS-990).
  // cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/ws.rs — that side sends one `runner:register` per bound project, which is what makes the project part of the key load-bearing rather than incidental.
  const [existing] = await db
    .select()
    .from(runners)
    .where(
      and(
        eq(runners.projectId, input.projectId),
        eq(runners.deviceId, principal.deviceId),
        eq(runners.type, input.type),
      ),
    )
    .limit(1);

  const wasOffline = existing?.status !== 'online';
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
          deviceId: principal.deviceId,
          name: input.name,
          labels: input.labels ?? [],
          capabilities: defaultRunnerCapabilities(input.type, input.capabilities),
          config: input.config ?? {},
          status: 'online',
          lastSeenAt: new Date(),
        })
        .returning({ id: runners.id });
      if (!inserted) return;
      runnerId = inserted.id;
    } catch (err) {
      // cm:guard scope the re-select by PROJECT as well as device and type — the index that raced is `runners_project_device_type_uq`, so a device bound to two projects has a second row matching on device and type alone, and the unscoped read returned the other project's runner and set IT online (ISS-990).
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        const [retry] = await db
          .select()
          .from(runners)
          .where(
            and(
              eq(runners.projectId, input.projectId),
              eq(runners.deviceId, principal.deviceId),
              eq(runners.type, input.type),
            ),
          )
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
  // cm:guard announce, never act — this file must not import the job layer, which is what put it inside a 52-file import cycle the last time it did. A box coming back online is news; what to do about it is the master's on that box.
  if (wasOffline) {
    void hooks.emit('runnerOnline', { projectId: input.projectId, runnerId });
  }
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
  if (input.capabilities) update.capabilities = input.capabilities;
  if (input.labels) update.labels = input.labels;
  if (input.name) update.name = input.name;
  await db
    .update(runners)
    .set(update)
    .where(and(eq(runners.id, input.runnerId), eq(runners.deviceId, principal.deviceId)));
}
