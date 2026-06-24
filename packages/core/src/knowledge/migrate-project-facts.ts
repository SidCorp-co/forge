import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { RESERVED_PROJECT_FACT_KEYS } from '../projects/project-facts.js';
import { upsertKnowledgeEntry } from './service.js';

const RESERVED = new Set<string>(RESERVED_PROJECT_FACT_KEYS);

/**
 * Idempotent one-time migration: copy `agentConfig.projectFacts` +
 * `agentConfig.projectFactsConfig` into `knowledge_entries`.
 *
 * - Uses `onConflictDoNothing` (via `upsertKnowledgeEntry`'s insert path when
 *   the row already exists). Actually: upsertKnowledgeEntry does an
 *   onConflictDoUpdate, which would overwrite human edits. To be truly
 *   insert-only, we skip slugs that already exist.
 * - Reserved derived keys are skipped.
 * - orderIndex assigned from Object.entries() order to preserve declaration order.
 * - Degraded-write tolerant: embedding outage does not abort the migration.
 *
 * @param projectId — when supplied, migrates only that project; otherwise all.
 */
export async function migrateProjectFactsToKnowledge(
  projectId?: string,
): Promise<{ migrated: number; skipped: number; errors: number }> {
  const rows = await db
    .select({
      id: projects.id,
      agentConfig: projects.agentConfig,
    })
    .from(projects)
    .where(projectId ? eq(projects.id, projectId) : undefined);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const ac = (row.agentConfig as Record<string, unknown> | null) ?? {};
    const projectFacts =
      ac.projectFacts && typeof ac.projectFacts === 'object' && !Array.isArray(ac.projectFacts)
        ? (ac.projectFacts as Record<string, string>)
        : null;

    if (!projectFacts || Object.keys(projectFacts).length === 0) continue;

    const projectFactsConfig =
      ac.projectFactsConfig &&
      typeof ac.projectFactsConfig === 'object' &&
      !Array.isArray(ac.projectFactsConfig)
        ? (ac.projectFactsConfig as Record<string, { alwaysInject?: boolean }>)
        : {};

    const entries = Object.entries(projectFacts);
    for (let i = 0; i < entries.length; i++) {
      const [key, text] = entries[i] as [string, string];

      if (RESERVED.has(key)) {
        skipped++;
        continue;
      }
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        skipped++;
        continue;
      }

      const alwaysInject = projectFactsConfig[key]?.alwaysInject === true;
      const injection = alwaysInject ? 'always' : 'on_demand';

      try {
        // Use insert-only semantics: if a row with this (projectId, slug) already
        // exists, skip it (preserves post-migration human edits).
        const { knowledgeEntries } = await import('../db/schema.js');
        const { and, eq: drizzleEq } = await import('drizzle-orm');
        const [existing] = await db
          .select({ id: knowledgeEntries.id })
          .from(knowledgeEntries)
          .where(
            and(
              drizzleEq(knowledgeEntries.projectId, row.id),
              drizzleEq(knowledgeEntries.slug, key),
            ),
          )
          .limit(1);

        if (existing) {
          skipped++;
          continue;
        }

        await upsertKnowledgeEntry({
          projectId: row.id,
          slug: key,
          title: key,
          body: text,
          kind: 'guide',
          injection,
          confidence: 'verified',
          authoredBy: 'human',
          orderIndex: i,
        });
        migrated++;
      } catch (err) {
        logger.error(
          { err: (err as Error).message, projectId: row.id, slug: key },
          'knowledge.migrate: failed to migrate entry',
        );
        errors++;
      }
    }
  }

  logger.info({ migrated, skipped, errors }, 'knowledge.migrate: migration complete');
  return { migrated, skipped, errors };
}
