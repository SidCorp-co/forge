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
import { indexMemory } from './indexer.js';

// cm:guard these are DEFAULTS, not the thresholds in force — `pipelineConfig.knowledgePromotion` overrides `minRetrievals` and `candidatesPerRun` per project, and a reader that used the constant where the config belongs would report a rate the operator never chose.
export const PROMOTION_RETRIEVAL_MIN = 3;
export const PROMOTION_AGE_DAYS = 7;
export const PROMOTION_CANDIDATES_PER_RUN = 3;
const PROMOTABLE_SOURCES = ['knowledge', 'decision'] as const;

export interface KnowledgePromotionConfig {
  enabled: boolean;
  candidatesPerRun: number;
  minRetrievals: number;
}

// cm:edge contract -> packages/core/src/pipeline/pipeline-config-schema.ts#knowledgePromotion — that schema STRIPS unknown keys, so a field read here but not declared there arrives as undefined however the operator set it
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

// cm:guard this NEVER writes `knowledge_entries` and NEVER sets `injection='always'` — it proposes, and a human or the pipeline decides. Writing the curated store from a nightly job would put unreviewed text into every future agent's context with nothing in between, which is the failure the proposal step exists to prevent.
// cm:guard proposals land at `open`, which auto-triages into a pipeline run — so this is capacity, not bookkeeping, and it is why `enabled` ships absent. It was `draft` until 2026-09-05: measured then, 71 proposals had produced 8 worked items and 63 that sat until someone swept them, because a draft has no owner and nothing ages it.
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

    await indexMemory({
      projectId,
      source: candidate.source as (typeof PROMOTABLE_SOURCES)[number],
      sourceRef: candidate.sourceRef,
      text: candidate.textContent,
      metadata: {
        ...((candidate.metadata ?? {}) as Record<string, unknown>),
        promotionProposedAt: ageThreshold.toISOString(),
      },
    });

    logger.info(
      { projectId, sourceRef: candidate.sourceRef, issueId: inserted.id },
      'memory.consolidation: promotion issue created',
    );
  }
}
