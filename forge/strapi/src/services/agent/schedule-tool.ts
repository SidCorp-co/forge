import type { ForgeTool } from './tools';

const SCHEDULE_UID = 'api::schedule.schedule' as any;
const PROJECT_UID = 'api::project.project';

async function resolveTargetProject(strapi: any, slug: string): Promise<string | null> {
  const project = await strapi.documents(PROJECT_UID).findFirst({
    filters: { slug: { $eq: slug } },
    fields: ['documentId'],
  });
  return project?.documentId || null;
}

/** Minimum interval: 1 hour (3600 seconds). */
function validateMinInterval(cron: string): string | null {
  try {
    const cronParser = require('cron-parser');
    const interval = cronParser.parseExpression(cron);
    const t1 = interval.next().getTime();
    const t2 = interval.next().getTime();
    const diffMs = t2 - t1;
    if (diffMs < 3600_000) {
      return `Minimum schedule interval is 1 hour. This cron runs every ${Math.round(diffMs / 60_000)} minutes.`;
    }
    return null;
  } catch {
    return 'Invalid cron expression.';
  }
}

function computeNextRunAt(cron: string): string | null {
  try {
    const cronParser = require('cron-parser');
    const interval = cronParser.parseExpression(cron);
    return interval.next().toISOString();
  } catch {
    return null;
  }
}

export const forgeSchedule: ForgeTool = {
  name: 'forge_schedule',
  description: 'Scheduled agent jobs (cron). Actions: create, list, get, update, delete, run. Min interval: 1h. Use targetProjectSlug for cross-project.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'get', 'update', 'delete', 'run'],
      },
      documentId: {
        type: 'string',
        description: 'Schedule documentId (for get/update/delete/run)',
      },
      data: {
        type: 'object',
        description: 'Schedule data (for create/update)',
        properties: {
          name: { type: 'string', description: 'Human-readable name' },
          cron: { type: 'string', description: 'Cron expression (e.g. "0 */2 * * *"). Min 1-hour interval.' },
          prompt: { type: 'string', description: 'Prompt/instruction to execute' },
          runner: { type: 'string', enum: ['desktop', 'antigravity'], description: 'Execution target (default: antigravity)' },
          enabled: { type: 'boolean', description: 'Whether schedule is active' },
          targetProjectSlug: { type: 'string', description: 'Run in context of another project' },
          metadata: { type: 'object', description: 'Extra config (model, skill, etc.)' },
        },
      },
      filters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          runner: { type: 'string', enum: ['desktop', 'antigravity'] },
        },
      },
      targetProjectSlug: {
        type: 'string',
        description: 'Optional: access schedules in a different project by slug',
      },
    },
    required: ['action'],
  },

  async execute(input, ctx) {
    const action = input.action as string;

    // Resolve target project
    let projectDocId = ctx.projectDocumentId;
    if (input.targetProjectSlug) {
      const isReadOnly = action === 'list' || action === 'get';
      if (!isReadOnly && !ctx.crossProjectAccess) {
        return 'Error: cross-project write access denied. Only read operations allowed.';
      }
      const targetId = await resolveTargetProject(ctx.strapi, input.targetProjectSlug as string);
      if (!targetId) return `Error: project with slug "${input.targetProjectSlug}" not found`;
      projectDocId = targetId;
    }

    const docs = ctx.strapi.documents(SCHEDULE_UID);

    if (action === 'list') {
      const filters: any = { project: { documentId: { $eq: projectDocId } } };
      const f = input.filters as Record<string, any> | undefined;
      if (f?.enabled !== undefined) filters.enabled = { $eq: f.enabled };
      if (f?.runner) filters.runner = { $eq: f.runner };

      const schedules = await docs.findMany({
        filters,
        populate: ['project'],
        sort: { createdAt: 'desc' },
        limit: 50,
      });

      return JSON.stringify(
        schedules.map((s: any) => ({
          documentId: s.documentId,
          name: s.name,
          cron: s.cron,
          prompt: s.prompt,
          runner: s.runner,
          enabled: s.enabled,
          targetProjectSlug: s.targetProjectSlug || null,
          lastRunAt: s.lastRunAt,
          nextRunAt: s.nextRunAt,
          lastStatus: s.lastStatus,
          lastSessionId: s.lastSessionId,
        })),
      );
    }

    // Helper: fetch schedule and verify it belongs to the resolved project
    async function getOwnedSchedule(docId: string): Promise<{ schedule: any } | { error: string }> {
      const schedule = await docs.findOne({ documentId: docId, populate: ['project'] });
      if (!schedule) return { error: 'Error: schedule not found' };
      const ownerDocId = (schedule as any).project?.documentId;
      if (ownerDocId && ownerDocId !== projectDocId) {
        return { error: 'Error: schedule does not belong to your project. Use targetProjectSlug or enable crossProjectAccess.' };
      }
      return { schedule };
    }

    if (action === 'get') {
      const docId = input.documentId as string;
      if (!docId) return 'Error: documentId required for get action';
      const result = await getOwnedSchedule(docId);
      if ('error' in result) return result.error;
      return JSON.stringify(result.schedule);
    }

    if (action === 'create') {
      const data = input.data as Record<string, any> | undefined;
      if (!data) return 'Error: data required for create action';
      if (!data.name) return 'Error: name is required';
      if (!data.cron) return 'Error: cron is required';
      if (!data.prompt) return 'Error: prompt is required';

      const validationError = validateMinInterval(data.cron);
      if (validationError) return `Error: ${validationError}`;

      const nextRunAt = computeNextRunAt(data.cron);
      const created = await docs.create({
        data: {
          name: data.name,
          cron: data.cron,
          prompt: data.prompt,
          runner: data.runner || 'antigravity',
          enabled: data.enabled !== false,
          targetProjectSlug: data.targetProjectSlug || null,
          metadata: data.metadata || null,
          project: projectDocId,
          nextRunAt,
        },
      });

      return JSON.stringify({
        documentId: created.documentId,
        name: created.name,
        cron: created.cron,
        runner: (created as any).runner,
        enabled: (created as any).enabled,
        nextRunAt: (created as any).nextRunAt,
      });
    }

    if (action === 'update') {
      const docId = input.documentId as string;
      if (!docId) return 'Error: documentId required for update action';
      const ownerCheck = await getOwnedSchedule(docId);
      if ('error' in ownerCheck) return ownerCheck.error;
      const data = input.data as Record<string, any> | undefined;
      if (!data) return 'Error: data required for update action';

      if (data.cron) {
        const validationError = validateMinInterval(data.cron);
        if (validationError) return `Error: ${validationError}`;
        data.nextRunAt = computeNextRunAt(data.cron);
      }
      // Compute nextRunAt when enabling a schedule that doesn't have one
      if (data.enabled === true && !data.cron) {
        const existingCron = (ownerCheck.schedule as any).cron;
        if (existingCron && !(ownerCheck.schedule as any).nextRunAt) {
          data.nextRunAt = computeNextRunAt(existingCron);
        }
      }

      const updated = await docs.update({ documentId: docId, data });
      if (!updated) return 'Error: schedule not found';
      return JSON.stringify({
        documentId: updated.documentId,
        name: updated.name,
        cron: (updated as any).cron,
        enabled: (updated as any).enabled,
        nextRunAt: (updated as any).nextRunAt,
      });
    }

    if (action === 'delete') {
      const docId = input.documentId as string;
      if (!docId) return 'Error: documentId required for delete action';
      const ownerCheck = await getOwnedSchedule(docId);
      if ('error' in ownerCheck) return ownerCheck.error;
      const deleted = await docs.delete({ documentId: docId });
      if (!deleted) return 'Error: schedule not found';
      return JSON.stringify({ deleted: true, documentId: docId });
    }

    if (action === 'run') {
      const docId = input.documentId as string;
      if (!docId) return 'Error: documentId required for run action';
      const ownerCheck = await getOwnedSchedule(docId);
      if ('error' in ownerCheck) return ownerCheck.error;

      try {
        const { dispatchSchedule } = require('../schedule-executor');
        const sessionId = await dispatchSchedule(ctx.strapi, ownerCheck.schedule);
        return JSON.stringify({ triggered: true, documentId: docId, sessionId });
      } catch (err: any) {
        return `Error: ${err.message || 'Failed to dispatch schedule'}`;
      }
    }

    return `Unknown action: ${action}`;
  },
};
