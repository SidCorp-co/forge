import { inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';

/** The id, slug and name of each project in `ids` that exists. */
export async function projectNamesOf(ids: readonly string[]) {
  return db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, [...ids]));
}
