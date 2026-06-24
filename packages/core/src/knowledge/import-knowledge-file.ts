import * as fs from 'node:fs';
import * as path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries } from '../db/schema.js';
import { logger } from '../logger.js';
import { upsertKnowledgeEntry } from './service.js';

const KNOWLEDGE_FILE = '.forge/knowledge.json';

/**
 * Idempotent one-time importer: reads an existing `.forge/knowledge.json`
 * from a consumer repo and writes each top-level entry into `knowledge_entries`
 * (kind='reference', authoredBy='imported').
 *
 * Insert-only — slugs that already exist in the table are skipped so that
 * post-import human edits are preserved on re-run.
 *
 * Core has no repo checkout on forge-beta, so this helper is intended to be
 * called from the dev-driven provision path (e.g. alongside
 * migrateProjectFactsToKnowledge) where a repoPath is available. Do NOT add
 * an always-on server filesystem read in the request path.
 */
export async function importKnowledgeFileForProject(
  projectId: string,
  repoPath: string,
): Promise<{ imported: number; skipped: number; errors: number }> {
  const filePath = path.join(repoPath, KNOWLEDGE_FILE);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { imported: 0, skipped: 0, errors: 0 };
  }

  let parsed: Record<string, unknown>;
  try {
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      logger.warn({ projectId, filePath }, 'knowledge.import: root is not an object — skip');
      return { imported: 0, skipped: 0, errors: 0 };
    }
    parsed = json as Record<string, unknown>;
  } catch {
    logger.warn({ projectId, filePath }, 'knowledge.import: JSON parse failed — skip');
    return { imported: 0, skipped: 0, errors: 0 };
  }

  const entries = Object.entries(parsed);
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i] as [string, unknown];
    const body =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2);

    if (!body || body.trim().length === 0) {
      skipped++;
      continue;
    }

    const slug = key
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^([^a-z0-9])/, 'k$1')
      .slice(0, 512) || `entry-${i}`;

    try {
      const [existing] = await db
        .select({ id: knowledgeEntries.id })
        .from(knowledgeEntries)
        .where(
          and(
            eq(knowledgeEntries.projectId, projectId),
            eq(knowledgeEntries.slug, slug),
          ),
        )
        .limit(1);

      if (existing) {
        skipped++;
        continue;
      }

      await upsertKnowledgeEntry({
        projectId,
        slug,
        title: key,
        body: body.trim(),
        kind: 'reference',
        injection: 'on_demand',
        confidence: 'inferred',
        authoredBy: 'imported',
        orderIndex: i,
        metadata: { importedFrom: KNOWLEDGE_FILE },
      });
      imported++;
    } catch (err) {
      logger.error(
        { err: (err as Error).message, projectId, slug },
        'knowledge.import: failed to import entry',
      );
      errors++;
    }
  }

  logger.info({ imported, skipped, errors, projectId }, 'knowledge.import: complete');
  return { imported, skipped, errors };
}
