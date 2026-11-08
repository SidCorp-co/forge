import { db } from '../db/client.js';
import { memoizedPerId, rowsPerId } from '../db/read-memo.js';
import { heldEcosystem } from './ecosystem-service.js';
import { edgesIn } from './interface-store.js';
import { membershipsWhere } from './membership-store.js';
import type { PartyGraph } from './party.js';
import type { VisibilityMode } from './schema.js';
import { readEcosystems } from './store.js';

/**
 * The ecosystems' members and edges. Each ecosystem's rows are its own, so every ecosystem a read
 * asks before its quiet point is read in one statement of each (`db/read-memo.ts`, ISS-1070 r12):
 * each of a person's projects in an ecosystem read its graph in three statements of its own.
 */
export async function loadGraph(ecosystemIds: readonly string[]): Promise<PartyGraph> {
  const ids = [...new Set(ecosystemIds)];
  if (ids.length === 0) return { active: new Map(), visibility: new Map(), edges: [] };
  const [ecos, memberships, edges] = await Promise.all([
    memoizedPerId('ecosystemRow', ids, async (some) => {
      const rows = await readEcosystems(db, some);
      return new Map(rows.map((e) => [e.id, e]));
    }),
    rowsPerId(
      'ecosystemMemberships',
      ids,
      (some) => membershipsWhere({ ecosystemIds: some }),
      (m) => m.ecosystemId,
    ),
    rowsPerId(
      'ecosystemEdges',
      ids,
      (some) => edgesIn(db, some),
      (e) => e.ecosystemId,
    ),
  ]);
  const active = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const m of memberships)
    if (m.state === 'active') active.get(m.ecosystemId)?.add(m.projectId);
  const visibility = new Map<string, VisibilityMode>(
    [...ecos.values()].map((e) => [e.id, heldEcosystem(e).document.visibility.members]),
  );
  return { active, visibility, edges };
}
