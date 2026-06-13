/**
 * ISS-431 — periodic connection health sweep.
 *
 * Health is otherwise written only when something happens: a deploy dispatch
 * (coolify, ISS-429), an explicit Test, or the create/bind probe. MCP-injection
 * providers (postman/epodsystem) never dispatch, so without this sweep their
 * `lastHealthStatus` freezes at whatever the last manual Test recorded — a
 * stale `error` (or `ok`) can sit on the card for weeks. The sweep re-probes
 * each ACTIVE connection that has at least one ACTIVE binding, hourly, via the
 * adapter's own `healthcheck` (which persists the result + needs_reauth
 * detection itself).
 *
 * Scope guards:
 *  - one probe per CONNECTION (not per binding) — health lives on the
 *    connection; the first pair supplies the config/env context.
 *  - connections probed in the last {@link MIN_PROBE_AGE_MS} are skipped so
 *    the sweep never stomps a fresher deploy/test signal.
 *  - probes run sequentially with a per-probe timeout — a hung provider costs
 *    one timeout, not the whole sweep.
 */

import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings, integrationConnections } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { raceWithTimeout } from './probe.js';
import { getAdapter } from './registry.js';
import { type BindingWithConnection, buildContextFromBinding } from './store.js';

export const HEALTH_SWEEP_QUEUE = 'integrations-health-sweep';

/** Skip connections probed more recently than this (fresh deploy/test wins). */
const MIN_PROBE_AGE_MS = 30 * 60 * 1000;

/** A probe that takes longer than this counts as failed and is abandoned. */
const PROBE_TIMEOUT_MS = 10_000;

/** All (binding, connection) pairs where BOTH sides are active. */
async function listActivePairs(): Promise<BindingWithConnection[]> {
  return db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(
      and(
        eq(integrationBindings.active, true),
        eq(integrationConnections.active, true),
        isNotNull(integrationConnections.secretsEnc),
      ),
    )
    .orderBy(asc(integrationBindings.createdAt));
}

export async function runIntegrationsHealthSweep(): Promise<{
  probed: number;
  skippedFresh: number;
  failed: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  const pairs = await listActivePairs();

  // One representative pair per connection — oldest binding first (same
  // ordering the resolver pick uses), so the probed context is stable.
  const byConnection = new Map<string, BindingWithConnection>();
  for (const pair of pairs) {
    if (!byConnection.has(pair.connection.id)) byConnection.set(pair.connection.id, pair);
  }

  let probed = 0;
  let skippedFresh = 0;
  let failed = 0;
  const cutoff = Date.now() - MIN_PROBE_AGE_MS;

  for (const pair of byConnection.values()) {
    const lastAt = pair.connection.lastHealthAt?.getTime() ?? 0;
    if (lastAt > cutoff) {
      skippedFresh++;
      continue;
    }
    const adapter = getAdapter(pair.binding.provider);
    if (!adapter) continue;
    try {
      const result = await raceWithTimeout(
        adapter.healthcheck(buildContextFromBinding(pair)),
        PROBE_TIMEOUT_MS,
      );
      if (result === null) {
        failed++;
        logger.warn(
          { connectionId: pair.connection.id, provider: pair.binding.provider },
          'integrations-health-sweep: probe timed out',
        );
        continue;
      }
      probed++;
    } catch (err) {
      // The adapter persists its own failure states; a transport-level crash
      // here just means this connection keeps its previous health this round.
      failed++;
      logger.warn(
        { err, connectionId: pair.connection.id, provider: pair.binding.provider },
        'integrations-health-sweep: probe crashed',
      );
    }
  }

  return { probed, skippedFresh, failed, durationMs: Date.now() - t0 };
}

let registered = false;

export async function registerIntegrationsHealthSweep(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(HEALTH_SWEEP_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(HEALTH_SWEEP_QUEUE, async () => {
    try {
      const result = await runIntegrationsHealthSweep();
      logger.info(result, 'integrations-health-sweep: complete');
    } catch (err) {
      logger.error({ err }, 'integrations-health-sweep: failed');
      throw err;
    }
  });
  // Hourly at :17 — offset from the */5 stale sweep and on-the-hour crons.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(HEALTH_SWEEP_QUEUE, '17 * * * *');
  registered = true;
}

export function resetIntegrationsHealthSweepForTest(): void {
  registered = false;
}
