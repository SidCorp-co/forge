/**
 * What Forge holds of a monitoring connection beside its row (ISS-1225): the readiness last read from
 * its server, and the two tokens Forge mints for it, `sd` for its Prometheus and `alerts` for its
 * Alertmanager. A token is 256 random bits shown once and kept as its SHA-256, as a project's agent
 * token is; minting a new one replaces the old, which admits nothing from then on.
 */

import {
  MONITORING_CONNECTION_TOKEN_KINDS,
  MONITORING_CONNECTION_TOKEN_PATTERN,
  MONITORING_CONNECTION_TOKEN_PREFIXES,
  type MonitoringConnectionTokenKind,
  type MonitoringReadiness,
  type MonitoringTokenResponse,
} from '@forge/contracts/monitoring';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationConnections } from '../../db/schema-integrations.js';
import { monitoringConnections } from '../../db/schema-monitoring.js';
import { digestToken, mintPrefixedToken, SHOWN_TOKEN_CHARS } from '../../lib/token-digest.js';

const columns = {
  sd: {
    hash: monitoringConnections.sdTokenHash,
    prefix: 'sdTokenPrefix',
    at: 'sdTokenCreatedAt',
    hashKey: 'sdTokenHash',
  },
  alerts: {
    hash: monitoringConnections.alertsTokenHash,
    prefix: 'alertsTokenPrefix',
    at: 'alertsTokenCreatedAt',
    hashKey: 'alertsTokenHash',
  },
} as const;

/** Record the readiness just read; a connection not stored yet (bound in its creating call) records nothing. */
export async function recordReadiness(
  connectionId: string,
  readiness: MonitoringReadiness,
): Promise<void> {
  const [stored] = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  if (!stored) return;
  await db
    .insert(monitoringConnections)
    .values({ connectionId, readiness })
    .onConflictDoUpdate({ target: monitoringConnections.connectionId, set: { readiness } });
}

export async function mintConnectionToken(
  connectionId: string,
  kind: MonitoringConnectionTokenKind,
): Promise<MonitoringTokenResponse> {
  const { token, hash } = mintPrefixedToken(MONITORING_CONNECTION_TOKEN_PREFIXES[kind]);
  const createdAt = new Date();
  const c = columns[kind];
  const set = {
    [c.hashKey]: hash,
    [c.prefix]: token.slice(0, SHOWN_TOKEN_CHARS),
    [c.at]: createdAt,
  };
  await db
    .insert(monitoringConnections)
    .values({ connectionId, ...set })
    .onConflictDoUpdate({ target: monitoringConnections.connectionId, set });
  return { token, prefix: token.slice(0, SHOWN_TOKEN_CHARS), createdAt: createdAt.toISOString() };
}

/** Whether `token` is the connection's token of this kind. */
export async function connectionAdmits(
  connectionId: string,
  kind: MonitoringConnectionTokenKind,
  token: string,
): Promise<boolean> {
  // the kind is the column its digest is looked up in: an sd token never admits at the alerts door
  if (!MONITORING_CONNECTION_TOKEN_PATTERN.test(token)) return false;
  const [row] = await db
    .select({ id: monitoringConnections.connectionId })
    .from(monitoringConnections)
    .where(
      and(
        eq(monitoringConnections.connectionId, connectionId),
        eq(columns[kind].hash, digestToken(token)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The readiness last recorded and each token as a listing shows it: never a secret. */
export async function monitoringConnectionHeld(connectionId: string): Promise<{
  readiness: MonitoringReadiness | null;
  tokens: Record<MonitoringConnectionTokenKind, { prefix: string; createdAt: string } | null>;
}> {
  const [row] = await db
    .select()
    .from(monitoringConnections)
    .where(eq(monitoringConnections.connectionId, connectionId))
    .limit(1);
  const tokenOf = (kind: MonitoringConnectionTokenKind) => {
    const prefix = row?.[columns[kind].prefix];
    const at = row?.[columns[kind].at];
    return prefix && at ? { prefix, createdAt: at.toISOString() } : null;
  };
  return {
    readiness: row?.readiness ?? null,
    tokens: Object.fromEntries(
      MONITORING_CONNECTION_TOKEN_KINDS.map((k) => [k, tokenOf(k)]),
    ) as Record<MonitoringConnectionTokenKind, { prefix: string; createdAt: string } | null>,
  };
}
