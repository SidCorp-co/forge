import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { notifications, pmDecisions, projects } from '../../db/schema.js';
import { hooks } from '../../pipeline/hooks.js';
import { type DeviceScopedMcpToolFactory, assertPmActor, zodToMcpSchema } from './lib.js';

/**
 * `forge_pm.escalate` (Epic 3, ISS-19) — PM agent surfaces a decision back
 * to the human owner via a `pm_escalation` notification. The decision row
 * must already exist (written first by `forge_pm.write_decision`); this
 * tool persists the escalation question + options so Epic 5's WS bridge
 * can broadcast `pm.escalation` to the owner's session.
 *
 * v1 sends to project owner only. The notification body is JSON-encoded
 * so the cloud UI / desktop can deserialize the choice payload without a
 * separate `pm_escalations` table.
 */

const inputSchema = z
  .object({
    projectId: z.uuid(),
    decisionId: z.uuid(),
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

const TITLE_MAX = 255;

export const forgePmEscalateTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_pm.escalate',
  description:
    'Escalate a PM decision to the project owner via a pm_escalation notification (with question + options + expiresAt). Requires PM-actor capability.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertPmActor(device, input.projectId);

    const [decision] = await db
      .select({ id: pmDecisions.id, projectId: pmDecisions.projectId })
      .from(pmDecisions)
      .where(and(eq(pmDecisions.id, input.decisionId), eq(pmDecisions.projectId, input.projectId)))
      .limit(1);
    if (!decision) {
      throw new Error('NOT_FOUND: pm decision not found in this project');
    }

    const [project] = await db
      .select({ ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project) throw new Error('NOT_FOUND: project not found');

    const title =
      input.summary.length > TITLE_MAX ? input.summary.slice(0, TITLE_MAX) : input.summary;
    const body = JSON.stringify({
      decisionId: input.decisionId,
      severity: input.severity,
      question: input.question,
      options: input.options,
      expiresAt: input.expiresAt,
    });

    const [inserted] = await db
      .insert(notifications)
      .values({
        userId: project.ownerId,
        projectId: input.projectId,
        type: 'pm_escalation',
        title,
        body,
      })
      .returning({ id: notifications.id });
    if (!inserted) throw new Error('forge_pm.escalate: notification insert returned no row');

    await hooks.emit('notificationCreated', {
      notificationId: inserted.id,
      userId: project.ownerId,
      projectId: input.projectId,
      type: 'pm_escalation',
      title,
      issueId: null,
      agentSessionId: null,
      decisionId: input.decisionId,
    });

    return { notificationId: inserted.id, expiresAt: input.expiresAt };
  },
});
