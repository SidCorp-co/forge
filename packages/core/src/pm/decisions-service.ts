/**
 * The durable record of a PM decision turn.
 *
 * The insert is followed by a detached memory-indexer call (`queueMicrotask`,
 * keeping the embedding round-trip off the request path — the same trade-off
 * `memory/indexer.ts` makes for comments). The indexer writes a `memories` row
 * keyed `source='decision'`, so a later PM turn can recall what was decided.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type ModelTier, pmDecisions, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { indexMemory } from '../memory/indexer.js';
import { emitNotification } from '../notifications/emit.js';

export const PM_DECISION_CAUSES = [
  'job-failed',
  'pipeline-stalled',
  'needs-info',
  'queue-pressure',
  'graph-changed',
  'operator',
  'operator-reply',
  'tick',
  'escalation-timeout',
  'pm-failure',
] as const;

const ESCALATION_TITLE_MAX = 255;

export type PmDecisionEscalation = {
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  expiresAt: string;
};

export type PmDecisionInput = {
  projectId: string;
  sessionId?: string | undefined;
  cause: (typeof PM_DECISION_CAUSES)[number];
  eventRef: Record<string, unknown>;
  summary: string;
  actions: Array<Record<string, unknown>>;
  confidence?: number | undefined;
  modelTier?: ModelTier | undefined;
  tookMs?: number | undefined;
  escalate?: PmDecisionEscalation | undefined;
};

/** Record one PM decision turn, and escalate to the project owner if asked. */
export async function writePmDecision(input: PmDecisionInput) {
  const [inserted] = await db
    .insert(pmDecisions)
    .values({
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      cause: input.cause,
      eventRef: input.eventRef,
      summary: input.summary,
      actions: input.actions,
      confidence: input.confidence ?? null,
      modelTier: input.modelTier ?? null,
      tookMs: input.tookMs ?? null,
    })
    .returning({ id: pmDecisions.id });
  if (!inserted) throw new Error('writePmDecision: insert returned no row');

  const decisionId = inserted.id;
  const indexText = `${input.summary}\n\n${JSON.stringify(input.actions)}`;
  queueMicrotask(() => {
    indexMemory({
      projectId: input.projectId,
      source: 'decision',
      sourceRef: decisionId,
      text: indexText,
      metadata: { cause: input.cause },
    }).catch((err) => {
      logger.error(
        { err: (err as Error).message, decisionId, projectId: input.projectId },
        'writePmDecision: detached indexer failed',
      );
    });
  });

  if (input.escalate) {
    const escalate = input.escalate;
    const [project] = await db
      .select({ createdBy: projects.createdBy })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project) throw new Error('NOT_FOUND: project not found');

    const title =
      escalate.summary.length > ESCALATION_TITLE_MAX
        ? escalate.summary.slice(0, ESCALATION_TITLE_MAX)
        : escalate.summary;
    const body = JSON.stringify({
      decisionId,
      severity: escalate.severity,
      question: escalate.question,
      options: escalate.options,
      expiresAt: escalate.expiresAt,
    });

    const escalationNotification = await emitNotification({
      userId: project.createdBy,
      projectId: input.projectId,
      type: 'pm_escalation',
      title,
      body,
      decisionId,
    });
    if (!escalationNotification) {
      throw new Error('writePmDecision: escalation notification insert returned no row');
    }

    return {
      decisionId,
      indexed: 'queued' as const,
      escalation: {
        notificationId: escalationNotification.id,
        expiresAt: escalate.expiresAt,
      },
    };
  }

  return { decisionId, indexed: 'queued' as const };
}
