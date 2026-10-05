import { db } from '../db/client.js';
import { heldEcosystem } from './ecosystem-service.js';
import { edgesIn } from './interface-store.js';
import { membershipsWhere } from './membership-store.js';
import type { PartyGraph } from './party.js';
import type { VisibilityMode } from './schema.js';
import { readEcosystems } from './store.js';

export async function loadGraph(ecosystemIds: readonly string[]): Promise<PartyGraph> {
  const ids = [...new Set(ecosystemIds)];
  const [ecos, memberships, edges] = await Promise.all([
    readEcosystems(db, ids),
    membershipsWhere({ ecosystemIds: ids }),
    edgesIn(db, ids),
  ]);
  const active = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const m of memberships)
    if (m.state === 'active') active.get(m.ecosystemId)?.add(m.projectId);
  const visibility = new Map<string, VisibilityMode>(
    ecos.map((e) => [e.id, heldEcosystem(e).document.visibility.members]),
  );
  return { active, visibility, edges };
}
