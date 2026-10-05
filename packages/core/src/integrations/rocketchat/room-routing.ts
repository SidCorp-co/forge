/**
 * Which project answers in which room, for one connection.
 *
 * A binding names a project and a set of rooms; this is the map the manager
 * reads on every message, rebuilt whenever a connection or a binding changes.
 */

import { logger } from '../../lib/logger.js';
import { forgeReads, listBindingsForConnection } from '../index.js';
import type { RocketChatBindingConfig } from './types.js';

/** One bound room, and the project whose handle answers in it. */
export interface Route {
  rid: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
}

export async function buildRoutes(connectionId: string): Promise<Map<string, Route>> {
  const routes = new Map<string, Route>();
  const active = (await listBindingsForConnection(connectionId))
    .map(({ binding: b }) => ({
      b,
      rids: (b.config as RocketChatBindingConfig | null)?.rids ?? [],
    }))
    .filter(({ b, rids }) => b.active && rids.length > 0);
  if (active.length === 0) return routes;

  const projectRows = await forgeReads().projectsByIds([
    ...new Set(active.map(({ b }) => b.projectId)),
  ]);
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  for (const { b, rids } of active) {
    const proj = projectById.get(b.projectId);
    if (!proj) continue;
    for (const rid of rids) {
      if (routes.has(rid)) {
        logger.warn(
          { connectionId, rid, projectId: b.projectId },
          'rocketchat: room already routed to another project; skipping duplicate',
        );
        continue;
      }
      routes.set(rid, {
        rid,
        projectId: b.projectId,
        projectSlug: proj.slug,
        projectName: proj.name,
      });
    }
  }
  return routes;
}
