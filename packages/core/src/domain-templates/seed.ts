import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { domainTemplates } from '../db/schema.js';
import { logger } from '../logger.js';
import type { BuiltinTemplate } from './manifest.js';
import { builtinTemplates } from './seeds/index.js';

export interface SeedResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

function canonicalManifestHash(manifest: BuiltinTemplate['manifest']): string {
  // JSON.stringify is canonical enough here because all builtin manifests are
  // hand-authored as plain objects with deterministic key order. If user-edited
  // manifests ever land, switch to a sorted-key serializer to keep hashes
  // stable across reorders.
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export async function seedDomainTemplates(db: Db): Promise<SeedResult> {
  const result: SeedResult = { inserted: 0, updated: 0, unchanged: 0 };

  for (const template of builtinTemplates) {
    const contentHash = canonicalManifestHash(template.manifest);

    const [existing] = await db
      .select({ id: domainTemplates.id, contentHash: domainTemplates.contentHash })
      .from(domainTemplates)
      .where(eq(domainTemplates.key, template.key))
      .limit(1);

    if (!existing) {
      await db.insert(domainTemplates).values({
        key: template.key,
        name: template.name,
        description: template.description,
        manifest: template.manifest,
        contentHash,
        builtin: true,
      });
      result.inserted += 1;
      continue;
    }

    if (existing.contentHash === contentHash) {
      result.unchanged += 1;
      continue;
    }

    // NOTE: bumping a builtin manifest only affects future apply calls; already-
    // applied projects keep the snapshot they were given (we don't store the
    // applied template version on the project today). See ISS-274 plan Risks.
    await db
      .update(domainTemplates)
      .set({
        name: template.name,
        description: template.description,
        manifest: template.manifest,
        contentHash,
        builtin: true,
        updatedAt: sql`now()`,
      })
      .where(eq(domainTemplates.key, template.key));
    result.updated += 1;
  }

  if (result.inserted > 0 || result.updated > 0) {
    logger.info({ ...result }, 'seedDomainTemplates: domain templates seeded');
  } else {
    logger.debug({ ...result }, 'seedDomainTemplates: all builtin templates up to date');
  }
  return result;
}
