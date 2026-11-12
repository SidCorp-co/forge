/**
 * A monitoring connection as the person who holds it works it (ISS-1225, owner 2026-11-12): the
 * readiness of its server, read now or as last recorded, the two tokens Forge mints for it, and the
 * setup list its server takes. The door deciding who may (`integration-door/connection-routes.ts`)
 * hands each a connection it already loaded.
 */

import type {
  MonitoringConnectionRead,
  MonitoringConnectionTokenKind,
  MonitoringReadiness,
  MonitoringSetupStep,
  MonitoringTokenResponse,
} from '@forge/contracts/monitoring';
import {
  mintConnectionToken,
  monitoringConnectionHeld,
  monitoringConnectionOf,
  readReadiness,
  recordReadiness,
} from '../integrations/prometheus/index.js';
import { env } from '../lib/env.js';
import { projectsBoundTo } from './connections.js';
import { monitoringSetup } from './setup.js';

/** The connection row a door loaded: a monitoring one, or null where it is another provider's. */
interface Row {
  id: string;
  provider: string;
  config: unknown;
  secretsEnc: Buffer | null;
}

const connOf = (row: Row) => (row.provider === 'prometheus' ? monitoringConnectionOf(row) : null);

export async function readMonitoringConnection(row: Row): Promise<MonitoringConnectionRead | null> {
  const conn = connOf(row);
  if (!conn) return null;
  const held = await monitoringConnectionHeld(row.id);
  return { connectionId: row.id, ruler: conn.config.ruler, ...held };
}

/** Read the server now and record what it can do. */
export async function rereadReadiness(row: Row): Promise<MonitoringReadiness | null> {
  const conn = connOf(row);
  if (!conn) return null;
  const readiness = await readReadiness(conn, row.id);
  await recordReadiness(row.id, readiness);
  return readiness;
}

export async function mintMonitoringToken(
  row: Row,
  kind: MonitoringConnectionTokenKind,
): Promise<MonitoringTokenResponse | null> {
  return connOf(row) ? mintConnectionToken(row.id, kind) : null;
}

export async function monitoringSetupOf(row: Row): Promise<MonitoringSetupStep[] | null> {
  const conn = connOf(row);
  if (!conn) return null;
  const bound = await projectsBoundTo(row.id);
  return monitoringSetup({
    connectionId: row.id,
    origin: (env.PUBLIC_API_BASE_URL ?? env.APP_BASE_URL).replace(/\/+$/, ''),
    user: conn.config.prometheusUser ?? '<prometheusUser>',
    ruler: conn.config.ruler,
    hostAgent: bound.some((p) => p.monitoring.agent?.enabled === true),
  });
}
