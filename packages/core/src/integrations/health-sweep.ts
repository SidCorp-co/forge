import { type Said, say, sayEn } from '@forge/contracts/said';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings, integrationConnections } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { healthReadsBinding, withBindingHealth } from './binding-health.js';
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
  const pairs = await withBindingHealth(await listActivePairs());

  // A provider whose check reads only the credential is probed once per connection, through its
  // oldest binding (the resolver's ordering), so the probed context is stable. One whose check reads
  // a binding's own target is probed per binding: probing one would leave every other binding's
  // repository, hooks or targets unread (ISS-983).
  const cutoff = Date.now() - MIN_PROBE_AGE_MS;
  const fresh = (at: Date | null) => (at?.getTime() ?? 0) > cutoff;
  const toProbe: BindingWithConnection[] = [];
  let skippedFresh = 0;
  const seen = new Set<string>();
  for (const pair of pairs) {
    const perBinding = healthReadsBinding(pair.binding.provider);
    const key = perBinding ? pair.binding.id : pair.connection.id;
    if (seen.has(key)) continue;
    seen.add(key);
    // a credential that failed recently is failing for every binding of it: one probe an hour asks
    // again, not one per binding
    const credentialFailed =
      pair.connection.lastHealthStatus != null && pair.connection.lastHealthStatus !== 'ok';
    const recent = perBinding
      ? fresh(pair.health?.checkedAt ?? null) ||
        (credentialFailed && fresh(pair.connection.lastHealthAt))
      : fresh(pair.connection.lastHealthAt);
    if (recent) {
      skippedFresh++;
      continue;
    }
    toProbe.push(pair);
  }

  let probed = 0;
  let failed = 0;

  for (const pair of toProbe) {
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
