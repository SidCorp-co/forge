/**
 * `forge_pm.write_decision` (Epic 3, ISS-19) — durable record of a PM
 * decision turn. Inserts a `pm_decisions` row, then queues a memory-indexer
 * call (detached via `queueMicrotask` to keep the embedding round-trip off
 * the request path — same trade-off as the comment indexer in
 * `memory/indexer.ts`). The indexer writes a `memories` row keyed on
 * `source='decision'` so future PM turns can semantically recall what was
 * decided and why.
 *
 * ISS-145: handler body extracted into `pmWriteDecisionHandler` and
 * consumed by both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 *
 * TODO ISS-145-followup: remove the legacy shim factory after the
 * deprecation window closes.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { db } from '../../db/client.js';
import { modelTiers, pmDecisions, projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { indexMemory } from '../../memory/indexer.js';
import { emitNotification } from '../../notifications/emit.js';
import { deprecationFor } from '../deprecation.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  assertPmActor,
  zodToMcpSchema,
} from './lib.js';

const ESCALATION_TITLE_MAX = 255;

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

const escalateSchema = z
  .object({
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    summary: z.string().min(1).max(2000),
    question: z.string().min(1).max(2000),
    options: z
      .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(255) }))
      .min(1)
      .max(8),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const pmWriteDecisionInputSchema = z
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
    escalate: escalateSchema.optional(),
  })
  .strict();

export async function pmWriteDecisionHandler(
  device: Device,
  input: z.infer<typeof pmWriteDecisionInputSchema>,
) {
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

  // Decision is durable before escalation; notification failure surfaces but does not roll back the decision row.
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

    // ISS-510 — route through the single emission helper so severity (warning,
    // from the contract) + the `notificationCreated` hook fan-out (incl. the
    // project-room escalation bridge via `decisionId`) stay consistent.
    const escalationNotification = await emitNotification({
      userId: project.createdBy,
      projectId: input.projectId,
      type: 'pm_escalation',
      title,
      body,
      decisionId,
    });
    if (!escalationNotification) {
      throw new Error('forge_pm.write_decision: escalation notification insert returned no row');
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

function recordDeprecation(ctx: McpContext, toolName: string) {
  if (deprecationFor(toolName) && ctx.deprecations) ctx.deprecations.add(toolName);
}

export const forgePmWriteDecisionTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pm.write_decision',
  description:
    "[DEPRECATED — use forge_project_pm (action=write_decision)] Record a PM decision (cause + summary + actions) and queue it for memory indexing under source=decision. To escalate alongside the decision, pass an 'escalate' object — top-level 'summary' is the decision summary, 'escalate.summary' is the notification title shown to the project owner. Requires PM-actor capability.",
  inputSchema: zodToMcpSchema(pmWriteDecisionInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.write_decision');
    const input = pmWriteDecisionInputSchema.parse(args);
    return pmWriteDecisionHandler(ctx.device, input);
  },
});
