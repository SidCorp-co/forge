/**
 * Which project answers in which room, for one connection.
 *
 * A binding names a project and a set of rooms; this is the map the manager
 * reads on every message, rebuilt whenever a connection or a binding changes.
 */

import { inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { organizations, projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { listBindingsForConnection } from '../store.js';
import type { RocketChatBindingConfig } from './types.js';

/** One bound room, and the project whose handle answers in it. */
export interface Route {
  rid: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  principalUserId: string;
}

export async function buildRoutes(connectionId: string): Promise<Map<string, Route>> {
  const routes = new Map<string, Route>();
  // cm:why two batched lookups, not a projects+organizations pair per binding: this was 1+2N round-trips and `reload` fires on ANY connection/binding CRUD, so a 10-binding connection paid 21 of them every reload
  const active = (await listBindingsForConnection(connectionId))
    .map(({ binding: b }) => ({
      b,
      rids: (b.config as RocketChatBindingConfig | null)?.rids ?? [],
    }))
    .filter(({ b, rids }) => b.active && rids.length > 0);
  if (active.length === 0) return routes;

  const projectRows = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name, orgId: projects.orgId })
    .from(projects)
    .where(inArray(projects.id, [...new Set(active.map(({ b }) => b.projectId))]));
  const projectById = new Map(projectRows.map((p) => [p.id, p]));
  const orgIds = [...new Set(projectRows.map((p) => p.orgId))];
  const ownerByOrg = new Map(
    orgIds.length === 0
      ? []
      : (
          await db
            .select({ id: organizations.id, createdBy: organizations.createdBy })
            .from(organizations)
            .where(inArray(organizations.id, orgIds))
        ).map((o) => [o.id, o.createdBy] as const),
  );

  for (const { b, rids } of active) {
    const proj = projectById.get(b.projectId);
    if (!proj) continue;
    const principalUserId = ownerByOrg.get(proj.orgId);
    if (!principalUserId) continue;
    for (const rid of rids) {
      // cm:guard one room routes to exactly one project and the FIRST binding wins, which is only deterministic because listBindingsForConnection orders by desc(createdAt) — reorder that query and a re-bound room silently changes project
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
        principalUserId,
      });
    }
  }
  return routes;
}
