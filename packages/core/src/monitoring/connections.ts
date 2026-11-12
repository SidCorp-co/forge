/**
 * The monitoring connections the doors serve (ISS-1225): the one a door's path names, when the caller
 * presents the token Forge minted it for that door; the projects bound to it with role `monitoring`;
 * and the one a project binds. Nothing is served from a connection the caller did not prove it is.
 */

import {
  type MonitoringConfig,
  type MonitoringConnectionTokenKind,
  monitoringConfigSchema,
} from '@forge/contracts/monitoring';
import {
  findConnectionById,
  listActiveBindingsForProjectProvider,
  listActiveBindingsForProvider,
} from '../integrations/index.js';
import {
  connectionAdmits,
  type MonitoringConnection,
  monitoringConnectionOf,
} from '../integrations/prometheus/index.js';
import { listProjectHeads } from '../projects/index.js';

const PROVIDER = 'prometheus';

export interface ConnectionHeld {
  connectionId: string;
  conn: MonitoringConnection;
}

export interface BoundProject {
  projectId: string;
  slug: string;
  monitoring: MonitoringConfig;
}

/** The active monitoring connection `connectionId`, when `token` is its token for this door. */
export async function connectionAdmitting(
  connectionId: string,
  kind: MonitoringConnectionTokenKind,
  token: string,
): Promise<ConnectionHeld | null> {
  if (!(await connectionAdmits(connectionId, kind, token))) return null;
  const row = await findConnectionById(connectionId);
  if (!row?.active || row.provider !== PROVIDER) return null;
  const conn = monitoringConnectionOf(row);
  return conn ? { connectionId, conn } : null;
}

/** Every project bound to the connection with role `monitoring`, with what it watches. */
export async function projectsBoundTo(connectionId: string): Promise<BoundProject[]> {
  const pairs = (await listActiveBindingsForProvider(PROVIDER)).filter(
    (p) => p.connection.id === connectionId && p.binding.role === 'monitoring',
  );
  const heads = new Map(
    (await listProjectHeads(pairs.map((p) => p.binding.projectId))).map((h) => [h.id, h.slug]),
  );
  return pairs.flatMap((p) => {
    const slug = heads.get(p.binding.projectId);
    const watched = monitoringConfigSchema.safeParse(p.binding.config ?? {});
    return slug && watched.success
      ? [{ projectId: p.binding.projectId, slug, monitoring: watched.data }]
      : [];
  });
}

/** The project's monitoring binding and its connection, or null where it binds none. */
export async function bindingOfProject(
  projectId: string,
): Promise<(ConnectionHeld & { monitoring: MonitoringConfig }) | null> {
  const [pair] = (await listActiveBindingsForProjectProvider(projectId, PROVIDER)).filter(
    (p) => p.binding.role === 'monitoring',
  );
  if (!pair) return null;
  const conn = monitoringConnectionOf(pair.connection);
  const watched = monitoringConfigSchema.safeParse(pair.binding.config ?? {});
  if (!conn || !watched.success) return null;
  return { connectionId: pair.connection.id, conn, monitoring: watched.data };
}
