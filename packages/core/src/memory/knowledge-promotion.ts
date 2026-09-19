// Knowledge promotion — the one automatic path from durable memory into the curated knowledge
// store, and it never takes the last step itself: it files an issue and a worker decides.
//
// Runs as the tail of the nightly `memory-consolidation` job (03:00 UTC), per project, and only
// where `pipelineConfig.knowledgePromotion.enabled` is on. It lived inside consolidation.ts until
// 2026-09-05, unconditional and invisible — no toggle, no row in the schedules table, no way for
// the fleet owner to say what it was doing.

import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, memories, projects } from '../db/schema.js';
import { logger } from '../logger.js';

export const PROMOTION_RETRIEVAL_MIN = 3;
export const PROMOTION_AGE_DAYS = 7;
export const PROMOTION_CANDIDATES_PER_RUN = 3;
const PROMOTABLE_SOURCES = ['knowledge', 'decision'] as const;

export interface KnowledgePromotionConfig {
  enabled: boolean;
  candidatesPerRun: number;
  minRetrievals: number;
}

/** Read the project's promotion config. Absent → disabled; this feature is opt-in. */
export async function resolveKnowledgePromotion(
  projectId: string,
): Promise<KnowledgePromotionConfig> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const ac = (row?.agentConfig ?? {}) as { pipelineConfig?: { knowledgePromotion?: unknown } };
  const raw = ac.pipelineConfig?.knowledgePromotion as
    | { enabled?: unknown; candidatesPerRun?: unknown; minRetrievals?: unknown }
    | undefined;
  return {
    enabled: raw?.enabled === true,
    candidatesPerRun:
      typeof raw?.candidatesPerRun === 'number'
        ? raw.candidatesPerRun
        : PROMOTION_CANDIDATES_PER_RUN,
    minRetrievals:
      typeof raw?.minRetrievals === 'number' ? raw.minRetrievals : PROMOTION_RETRIEVAL_MIN,
  };
}

/**
 * Propose durable memory lessons for promotion into curated `knowledge_entries`.
 *
 * Candidates are memories with `source IN ('knowledge','decision')`, not archived, retrieved at
 * least `minRetrievals` times (durable — actually referenced), older than `PROMOTION_AGE_DAYS`,
 * and not already proposed. Each becomes one issue; the memory is then stamped
 * `metadata.promotionProposedAt` so it is never proposed twice.
 *
 * Best-effort: any error is logged and never breaks consolidation.
 */
export async function proposeKnowledgePromotions(projectId: string): Promise<void> {
  const cfg = await resolveKnowledgePromotion(projectId);
  if (!cfg.enabled) return;

  const [projectRow] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!projectRow?.createdBy) {
    logger.debug(
      { projectId },
      'memory.consolidation: proposeKnowledgePromotions: project not found or no creator',
    );
    return;
  }

  const ageThreshold = new Date(Date.now() - PROMOTION_AGE_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select({
      id: memories.id,
      source: memories.source,
      sourceRef: memories.sourceRef,
      textContent: memories.textContent,
      metadata: memories.metadata,
    })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, projectId),
        inArray(memories.source, [...PROMOTABLE_SOURCES]),
        isNull(memories.archivedAt),
        gte(memories.retrievalCount, cfg.minRetrievals),
        lte(memories.createdAt, ageThreshold),
        sql`${memories.metadata}->>'promotionProposedAt' IS NULL`,
      ),
    )
    .limit(cfg.candidatesPerRun);

  if (candidates.length === 0) return;

  for (const candidate of candidates) {
    const issueTitle = `Promote memory to knowledge: ${candidate.sourceRef}`;
    const issueDescription = [
      '## Promotion proposal',
      '',
      `**Memory source:** \`${candidate.source}\``,
      `**Source ref:** \`${candidate.sourceRef}\``,
      '',
      '### Lesson',
      '',
      candidate.textContent,
      '',
      '### Proposed knowledge entry',
      '',
      '- **kind:** `guide` or `rule` (reviewer decides)',
      '- **injection:** `on_demand` (NEVER `always`)',
      '- **body:** the lesson text above, refined as appropriate',
      '',
      `*Proposed automatically by the nightly memory consolidation job (03:00 UTC), because \`pipelineConfig.knowledgePromotion.enabled\` is on for this project and the memory above has been retrieved at least ${cfg.minRetrievals} times. Turn it off in Project settings → Pipeline → Knowledge promotion. Nothing writes curated knowledge without this issue being worked.*`,
    ].join('\n');

    const [inserted] = await db
      .insert(issues)
      .values({
        projectId,
        title: issueTitle,
        description: issueDescription,
        status: 'open',
        priority: 'low',
        category: 'knowledge-promotion',
        createdById: projectRow.createdBy,
        createdVia: 'schedule',
      })
      .returning({ id: issues.id });

    if (!inserted) {
      logger.warn(
        { projectId, sourceRef: candidate.sourceRef },
        'memory.consolidation: promotion issue insert returned no row',
      );
      continue;
    }

    await db
      .update(memories)
      .set({
        metadata: sql`${memories.metadata} || ${JSON.stringify({
          promotionProposedAt: ageThreshold.toISOString(),
        })}::jsonb`,
        updatedAt: sql`now()`,
      })
      .where(eq(memories.id, candidate.id));

    logger.info(
      { projectId, sourceRef: candidate.sourceRef, issueId: inserted.id },
      'memory.consolidation: promotion issue created',
    );
  }
}
