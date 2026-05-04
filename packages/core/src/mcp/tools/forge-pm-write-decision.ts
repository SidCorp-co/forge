import { z } from 'zod';
import { db } from '../../db/client.js';
import { modelTiers, pmDecisions } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { indexMemory } from '../../memory/indexer.js';
import {
  type DeviceScopedMcpToolFactory,
  assertPmActor,
  zodToMcpSchema,
} from './lib.js';

/**
 * `forge_pm.write_decision` (Epic 3, ISS-19) — durable record of a PM
 * decision turn. Inserts a `pm_decisions` row, then queues a memory-indexer
 * call (detached via `queueMicrotask` to keep the embedding round-trip off
 * the request path — same trade-off as the comment indexer in
 * `memory/indexer.ts`). The indexer writes a `memories` row keyed on
 * `source='decision'` so future PM turns can semantically recall what was
 * decided and why.
 */

const PM_DECISION_CAUSES = [
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

const inputSchema = z
  .object({
    projectId: z.uuid(),
    sessionId: z.uuid().optional(),
    cause: z.enum(PM_DECISION_CAUSES),
    eventRef: z.record(z.string(), z.unknown()).default({}),
    summary: z.string().min(1).max(4000),
    actions: z.array(z.record(z.string(), z.unknown())).default([]),
    confidence: z.number().min(0).max(1).optional(),
    modelTier: z.enum(modelTiers).optional(),
    tookMs: z.number().int().min(0).optional(),
  })
  .strict();

export const forgePmWriteDecisionTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_pm.write_decision',
  description:
    'Record a PM decision (cause + summary + actions) and queue it for memory indexing under source=decision. Requires PM-actor capability.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertPmActor(device, input.projectId);

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
    if (!inserted) throw new Error('forge_pm.write_decision: insert returned no row');

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
          'forge_pm.write_decision: detached indexer failed',
        );
      });
    });

    return { decisionId, indexed: 'queued' as const };
  },
});
