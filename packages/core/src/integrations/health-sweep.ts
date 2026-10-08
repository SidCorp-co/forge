import { type Said, say, sayEn } from '@forge/contracts/said';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings, integrationConnections } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { thrownSaid } from './health-said.js';
import { raceWithTimeout } from './probe.js';
import { getAdapter } from './registry.js';
import { type BindingWithConnection, buildContextFromBinding, updateConnection } from './store.js';

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
    // A probe that hangs or crashes records why, so the card never keeps a stale `ok`.
    let fault: Said | null = null;
    try {
      const result = await raceWithTimeout(
        adapter.healthcheck(buildContextFromBinding(pair)),
        PROBE_TIMEOUT_MS,
      );
      if (result === null) {
        fault = say('integrations.health.timedOut', { seconds: PROBE_TIMEOUT_MS / 1000 });
      }
    } catch (err) {
      fault = say('integrations.health.crashed', { why: thrownSaid(err) });
    }
    if (fault === null) {
      probed++;
      continue;
    }
    failed++;
    logger.warn(
      { connectionId: pair.connection.id, provider: pair.binding.provider, fault: sayEn(fault) },
      'integrations-health-sweep: probe failed',
    );
    await updateConnection(pair.connection.id, {
      lastHealthStatus: 'degraded',
      lastHealthDetail: fault,
      lastHealthAt: new Date(),
    });
  }

  return { probed, skippedFresh, failed, durationMs: Date.now() - t0 };
}
