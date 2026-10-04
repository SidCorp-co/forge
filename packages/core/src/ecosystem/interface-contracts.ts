import { db } from '../db/client.js';
import { heldInterface } from './interface-service.js';
import { projectsWhere, readInterfaces } from './store.js';

/** The contracts `projectId`'s interface publishes and consumes, as `<project>/<contract>` refs; null when it holds none. */
export async function interfaceContractsOf(
  projectId: string,
): Promise<{ publishes: string[]; consumes: string[] } | null> {
  const [[own], held] = await Promise.all([
    projectsWhere(db, { ids: [projectId] }),
    readInterfaces(db, [projectId]).then((m) => m.get(projectId)),
  ]);
  if (!own || !held) return null;
  const doc = heldInterface(held, projectId).document;
  return {
    publishes: Object.keys(doc.publishes).map((slug) => `${own.slug}/${slug}`),
    consumes: doc.consumes.map((c) => c.contract),
  };
}
