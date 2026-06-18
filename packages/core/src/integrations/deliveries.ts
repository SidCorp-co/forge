import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IntegrationDeliveryDirection,
  type IntegrationDeliveryStatus,
  integrationDeliveries,
} from '../db/schema.js';

export interface RecordDeliveryInput {
  /** Binding the delivery is scoped to (the post-cutover key). */
  bindingId: string;
  direction: IntegrationDeliveryDirection;
  eventName: string;
  payload: unknown;
  requestId?: string;
  status?: IntegrationDeliveryStatus;
}

export interface UpdateDeliveryInput {
  status?: IntegrationDeliveryStatus;
  response?: unknown;
  errorMessage?: string | null;
  durationMs?: number;
  completedAt?: Date | null;
}

export async function recordDelivery(input: RecordDeliveryInput): Promise<string> {
  const [row] = await db
    .insert(integrationDeliveries)
    .values({
      bindingId: input.bindingId,
      direction: input.direction,
      eventName: input.eventName,
      payload: (input.payload ?? {}) as Record<string, unknown>,
      requestId: input.requestId ?? null,
      status: input.status ?? 'pending',
    })
    .returning({ id: integrationDeliveries.id });
  if (!row) throw new Error('recordDelivery: insert returned no row');
  return row.id;
}

export async function updateDelivery(id: string, patch: UpdateDeliveryInput): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.response !== undefined) set.response = patch.response;
  if (patch.errorMessage !== undefined) set.errorMessage = patch.errorMessage;
  if (patch.durationMs !== undefined) set.durationMs = patch.durationMs;
  if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
  if (Object.keys(set).length === 0) return;
  await db.update(integrationDeliveries).set(set).where(eq(integrationDeliveries.id, id));
}

/**
 * Counts outbound deliveries with the given status for a binding within the
 * lookback window. Used by the circuit breaker to decide whether to trip; the
 * owning connection's `active` flag is the breaker state.
 */
export async function countOutboundStatusInWindow(
  bindingId: string,
  status: IntegrationDeliveryStatus,
  windowMs: number,
): Promise<number> {
  const since = new Date(Date.now() - windowMs);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'outbound'),
        eq(integrationDeliveries.status, status),
        gte(integrationDeliveries.createdAt, since),
      ),
    );
  return row ? Number(row.n) : 0;
}

/**
 * Returns the last N outbound deliveries (most recent first) so the breaker
 * can ask "were the last 3 all failures?" — a stricter check than counting,
 * since a 1-failure-then-success run shouldn't trip.
 */
export async function recentOutboundDeliveries(
  bindingId: string,
  limit: number,
  windowMs: number,
): Promise<{ status: IntegrationDeliveryStatus; createdAt: Date }[]> {
  const since = new Date(Date.now() - windowMs);
  return db
    .select({
      status: integrationDeliveries.status,
      createdAt: integrationDeliveries.createdAt,
    })
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'outbound'),
        gte(integrationDeliveries.createdAt, since),
      ),
    )
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(limit);
}

export async function findLastSuccessfulOutbound(
  bindingId: string,
): Promise<typeof integrationDeliveries.$inferSelect | null> {
  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'outbound'),
        eq(integrationDeliveries.status, 'ok'),
      ),
    )
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Returns the most recent outbound delivery for an integration regardless of
 * status — used by `forge_coolify_deploy → status` to surface the latest
 * deployment attempt (including a still-`pending` or `failed` one) alongside
 * its `response.deployment_uuid`.
 */
export async function findLastOutbound(
  bindingId: string,
): Promise<typeof integrationDeliveries.$inferSelect | null> {
  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'outbound'),
      ),
    )
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Most recent outbound delivery for a specific deploy target (matched on the
 * jsonb `payload.targetId`). Powers the per-target `status` view so an operator
 * can see each app (backend / frontend) of a multi-target integration
 * independently. Returns null when that target has never been dispatched.
 */
export async function findLastOutboundForTarget(
  bindingId: string,
  targetId: string,
): Promise<typeof integrationDeliveries.$inferSelect | null> {
  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'outbound'),
        sql`${integrationDeliveries.payload}->>'targetId' = ${targetId}`,
      ),
    )
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Looks up a single delivery by its primary key. Returns the row or null. */
export async function findDeliveryById(
  id: string,
): Promise<typeof integrationDeliveries.$inferSelect | null> {
  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(eq(integrationDeliveries.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * All successfully-dispatched outbound deliveries for a binding + pipeline run
 * (matched on the jsonb `payload.runId`). Used by the Coolify inbound handler to
 * aggregate multi-target deploys: a run only advances to `done` once EVERY
 * target's deploy has reported success. Each row's `response.deployment_uuid`
 * keys the per-target inbound webhook.
 */
export async function listDispatchedOutboundForRun(
  bindingId: string,
  runId: string,
): Promise<(typeof integrationDeliveries.$inferSelect)[]> {
  return db
    .select()
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'outbound'),
        eq(integrationDeliveries.status, 'ok'),
        sql`${integrationDeliveries.payload}->>'runId' = ${runId}`,
      ),
    );
}

/**
 * The successful OUTBOUND deploy delivery whose Coolify response carried this
 * `deployment_uuid` — the inbound webhook handler uses it to recover the
 * pipeline run (+ target) that a deployment belongs to.
 */
export async function findOutboundByDeploymentUuid(
  bindingId: string,
  deploymentUuid: string,
): Promise<typeof integrationDeliveries.$inferSelect | null> {
  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'outbound'),
        eq(integrationDeliveries.status, 'ok'),
        sql`response->>'deployment_uuid' = ${deploymentUuid}`,
      ),
    )
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The inbound delivery (if any) recorded for a given Coolify `deployment_uuid`
 * on a binding — the webhook handler stores `requestId = deployment_uuid`. Used
 * to read a sibling target's terminal outcome during multi-target aggregation.
 */
export async function findInboundByDeploymentUuid(
  bindingId: string,
  deploymentUuid: string,
): Promise<typeof integrationDeliveries.$inferSelect | null> {
  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'inbound'),
        eq(integrationDeliveries.requestId, deploymentUuid),
      ),
    )
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Looks up an outbound delivery by its `(binding_id, request_id)` pair — the
 * same tuple the `integration_deliveries_binding_request_id_uq` partial unique
 * index covers. Returns the row or null. Used as the application-level
 * idempotency guard in the Coolify dispatch loop so a duplicate dispatch with
 * the same `requestId` (e.g. agent-driven + auto-subscriber) is skipped
 * instead of hitting a unique-violation inside the worker.
 */
export async function findDeliveryByRequestId(
  bindingId: string,
  requestId: string,
): Promise<typeof integrationDeliveries.$inferSelect | null> {
  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'outbound'),
        eq(integrationDeliveries.requestId, requestId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
