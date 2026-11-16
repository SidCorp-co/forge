// A requirement's module (ISS-1256): a field, set by the module map's placement door when a
// requirement is agreed or its module is known; never read off the issues that deliver it.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';

/** Set REQ-`reqSeq`'s module in the project; the module it had before, or undefined where none is REQ-`reqSeq`. */
export async function setRequirementModule(
  projectId: string,
  reqSeq: number,
  moduleId: string | null,
): Promise<{ previous: string | null; title: string } | undefined> {
  const where = and(eq(requirements.projectId, projectId), eq(requirements.reqSeq, reqSeq));
  const [before] = await db
    .select({ moduleId: requirements.moduleId, title: requirements.title })
    .from(requirements)
    .where(where);
  if (!before) return undefined;
  await db.update(requirements).set({ moduleId }).where(where);
  return { previous: before.moduleId, title: before.title };
}
