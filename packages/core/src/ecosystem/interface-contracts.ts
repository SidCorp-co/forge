import { db, type Tx } from '../db/client.js';
import { heldInterface } from './interface-service.js';
import { readInterfaces } from './interface-store.js';
import { projectsWhere } from './store.js';

/** The contracts `projectId`'s interface publishes and consumes, as `<project>/<contract>` refs; null when it holds none. */
export async function interfaceContractsOf(
  projectId: string,
  executor: Tx = db,
): Promise<{ publishes: string[]; consumes: string[] } | null> {
  const own = (await projectsWhere(executor, { ids: [projectId] }))[0];
  const held = (await readInterfaces(executor, [projectId])).get(projectId);
  if (!own || !held) return null;
  const doc = heldInterface(held, projectId).document;
  return {
    publishes: Object.keys(doc.publishes).map((slug) => `${own.slug}/${slug}`),
    consumes: doc.consumes.map((c) => c.contract),
  };
}
