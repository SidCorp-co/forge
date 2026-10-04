import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { domainTemplates } from '../db/schema.js';

/** Every domain template, by key. */
export async function listDomainTemplates() {
  return db.select().from(domainTemplates).orderBy(asc(domainTemplates.key));
}

/** One domain template by key, or null. */
export async function domainTemplateByKey(key: string) {
  const [row] = await db.select().from(domainTemplates).where(eq(domainTemplates.key, key)).limit(1);
  return row ?? null;
}
