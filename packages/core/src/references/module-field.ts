// A reference source's module (ISS-1256): the project's own source sits under one business module,
// set by the module map's placement door. An org entry is every project's and holds none.

import type { ModuleMapRefusalCode } from '@forge/contracts/module-map';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { referenceSources } from '../db/schema-references.js';
import { refuser } from '../lib/refusal.js';

const refuse = refuser<ModuleMapRefusalCode>('MODULE_MAP_REFUSED');

/**
 * Set source `sourceId`'s module; the module it had before, or undefined where the project reads no
 * live source by that id. An org entry is refused `MODULE_MAP_ORG_REFERENCE`.
 */
export async function setReferenceModule(
  projectId: string,
  sourceId: string,
  moduleId: string | null,
): Promise<{ previous: string | null; title: string } | undefined> {
  const [row] = await db
    .select({
      projectId: referenceSources.projectId,
      moduleId: referenceSources.moduleId,
      title: referenceSources.title,
    })
    .from(referenceSources)
    .where(and(eq(referenceSources.id, sourceId), isNull(referenceSources.removedAt)));
  if (!row) return undefined;
  if (row.projectId === null) {
    throw refuse(
      'MODULE_MAP_ORG_REFERENCE',
      `source ${sourceId} is an org entry every project shares; only a project's own source sits under one of its modules`,
      '/ref',
    );
  }
  if (row.projectId !== projectId) return undefined;
  await db.update(referenceSources).set({ moduleId }).where(eq(referenceSources.id, sourceId));
  return { previous: row.moduleId, title: row.title };
}
