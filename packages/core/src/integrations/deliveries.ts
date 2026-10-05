import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  type IntegrationDeliveryDirection,
  type IntegrationDeliveryStatus,
  integrationDeliveries,
} from '../db/schema.js';

interface RecordDeliveryInput {
  bindingId: string | null;
  direction: IntegrationDeliveryDirection;
  eventName: string;
  payload: unknown;
  requestId?: string;
  status?: IntegrationDeliveryStatus;
  errorMessage?: string;
}

interface UpdateDeliveryInput {
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
      bindingId: input.bindingId ?? null,
      direction: input.direction,
      eventName: input.eventName,
      payload: (input.payload ?? {}) as Record<string, unknown>,
      requestId: input.requestId ?? null,
      status: input.status ?? 'pending',
      errorMessage: input.errorMessage ?? null,
    })
    .returning({ id: integrationDeliveries.id });
  if (!row) throw new Error('recordDelivery: insert returned no row');
  return row.id;
}

/**
 * Claim an inbound delivery's row BEFORE applying it, keyed by the provider's delivery id: a first
 * arrival inserts it, a redelivery of a FAILED attempt takes that row over, and a redelivery of one
 * that succeeded or is still in flight is not applied again. The partial unique index on
 * (binding_id, request_id) is what makes the claim one writer's.
 */
async function claimInbound(input: Omit<RecordDeliveryInput, 'direction' | 'status'>) {
  const values = {
    bindingId: input.bindingId,
    direction: 'inbound' as const,
    eventName: input.eventName,
    payload: (input.payload ?? {}) as Record<string, unknown>,
    requestId: input.requestId ?? null,
    status: 'pending' as const,
  };
  const target = [integrationDeliveries.bindingId, integrationDeliveries.requestId];
  const [row] = await db
    .insert(integrationDeliveries)
    .values(values)
    .onConflictDoNothing({ target, where: isNotNull(integrationDeliveries.requestId) })
    .returning({ id: integrationDeliveries.id });
  if (row || !input.requestId || !input.bindingId)
    return row ? { id: row.id, claimed: true } : null;
  const sameDelivery = and(
    eq(integrationDeliveries.bindingId, input.bindingId),
    eq(integrationDeliveries.requestId, input.requestId),
  );
  const [taken] = await db
    .update(integrationDeliveries)
    .set({ ...values, errorMessage: null, completedAt: null })
    .where(and(sameDelivery, eq(integrationDeliveries.status, 'failed')))
    .returning({ id: integrationDeliveries.id });
  if (taken) return { id: taken.id, claimed: true };
  const [held] = await db
    .select({ id: integrationDeliveries.id })
    .from(integrationDeliveries)
    .where(sameDelivery)
    .limit(1);
  return held ? { id: held.id, claimed: false } : null;
}

/**
 * Apply one inbound event under its claimed row, then settle the row with what happened: `ok`, or
 * `failed` with the throw or the refusal the event answered. `settle` writes what the delivery
 * reports on the same transaction as the settle, so the row never reads `ok` while its facts are
 * unwritten: a throw from either leaves it `failed`, which a redelivery takes over and applies again.
 * `result` is null for a redelivery whose first attempt already succeeded or is in flight, which is
 * not applied twice.
 */
export async function applyClaimedInbound<
  R extends { actions: number; refusal?: string | null | undefined },
>(
  input: Omit<RecordDeliveryInput, 'direction' | 'status'>,
  apply: () => Promise<R>,
  settle: (tx: Tx) => Promise<void>,
): Promise<{ deliveryId: string; result: R | null }> {
  const claim = await claimInbound(input);
  if (!claim)
    throw new Error(`inbound delivery ${input.requestId}: no row could be claimed or found`);
  if (!claim.claimed) return { deliveryId: claim.id, result: null };
  try {
    const result = await apply();
    await db.transaction(async (tx) => {
      await settle(tx);
      await tx
        .update(integrationDeliveries)
        .set({
          status: result.refusal ? 'failed' : 'ok',
          ...(result.refusal ? { errorMessage: result.refusal } : {}),
          completedAt: new Date(),
        })
        .where(eq(integrationDeliveries.id, claim.id));
    });
    return { deliveryId: claim.id, result };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await updateDelivery(claim.id, { status: 'failed', errorMessage, completedAt: new Date() });
    throw err;
  }
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

/** A binding's latest 50 deliveries, newest first. */
export async function listBindingDeliveries(
  bindingId: string,
): Promise<(typeof integrationDeliveries.$inferSelect)[]> {
  return db
    .select()
    .from(integrationDeliveries)
    .where(eq(integrationDeliveries.bindingId, bindingId))
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(50);
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
