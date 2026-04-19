/**
 * Pikachu decision storage and outcome recording.
 */

import type { PikachuDecision, PikachuContext } from './types';
import { getDecisionType } from './decision';

// ─── Qdrant Storage ─────────────────────────────────────────────────────────

export async function storePikachuDecision(
  _strapi: any,
  ctx: PikachuContext,
  decision: PikachuDecision,
  sourceId: string,
): Promise<void> {
  const { upsertEmbedding } = await import('../embeddings/index');

  const decisionType = getDecisionType(ctx.toStatus);
  const text = `${decision.action} ${decision.skill || ''} for issue ${ctx.issueDocumentId.slice(0, 8)} (${ctx.fromStatus}→${ctx.toStatus}): ${decision.reasoning}`;

  await upsertEmbedding({
    project_id: ctx.projectDocumentId,
    source_type: 'pikachu_decision',
    source_id: sourceId,
    text,
    metadata: {
      action: decision.action,
      skill: decision.skill,
      reasoning: decision.reasoning,
      outcome: null,
      decisionType,
      fromStatus: ctx.fromStatus,
      toStatus: ctx.toStatus,
      issueDocumentId: ctx.issueDocumentId,
      decisionAt: new Date().toISOString(),
    },
  });
}

// ─── Outcome Recording ──────────────────────────────────────────────────────

const COLLECTION_NAME = 'forge_embeddings';

export async function recordPikachuOutcome(
  strapi: any,
  sourceId: string,
  outcome: 'success' | 'failed',
  error?: string,
): Promise<void> {
  try {
    const { getQdrantClient } = await import('../embeddings/qdrant');
    const qdrant = getQdrantClient();
    if (!qdrant) return;

    const scrollResult = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'source_type', match: { value: 'pikachu_decision' } },
          { key: 'source_id', match: { value: sourceId } },
        ],
      },
      limit: 1,
      with_payload: true,
    });

    const point = scrollResult.points[0];
    if (!point) return;

    const metadata = (point.payload as any)?.metadata || {};
    metadata.outcome = outcome;
    if (error) metadata.outcomeError = error;
    metadata.outcomeAt = new Date().toISOString();

    await qdrant.setPayload(COLLECTION_NAME, {
      payload: { metadata },
      filter: {
        must: [
          { key: 'source_id', match: { value: sourceId } },
        ],
      },
    });

    strapi.log.debug(`[pikachu] Recorded outcome ${outcome} for ${sourceId}`);
  } catch (err: any) {
    strapi.log.debug(`[pikachu] Failed to record outcome: ${err.message}`);
  }
}
