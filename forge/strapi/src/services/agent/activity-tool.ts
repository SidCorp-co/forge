import type { ForgeTool } from './tools';

const ACTIVITY_UID = 'api::activity.activity';
const PROJECT_UID = 'api::project.project';

/** Resolve a target project by slug. Returns the project documentId or null. */
async function resolveTargetProject(strapi: any, slug: string): Promise<string | null> {
  const project = await strapi.documents(PROJECT_UID).findFirst({
    filters: { slug: { $eq: slug } },
    fields: ['documentId'],
  });
  return project?.documentId || null;
}

const ACTIVITY_TYPES = [
  'comment', 'status_change', 'priority_change', 'label_added', 'label_removed',
  'title_change', 'category_change', 'created', 'enriched', 'agent_session',
  'relation_added', 'relation_removed', 'pikachu_decision',
];

export const forgeActivity: ForgeTool = {
  name: 'forge_activity',
  description: 'Cross-project activity feed. Actions: list. Filterable by project (targetProjectSlug), type, actor, date range.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list'] },
      targetProjectSlug: { type: 'string', description: 'Optional: filter activities to a specific project' },
      filters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ACTIVITY_TYPES, description: 'Activity type filter' },
          actor: { type: 'string', description: 'Filter by actor name' },
          after: { type: 'string', description: 'ISO date — activities after this date' },
          before: { type: 'string', description: 'ISO date — activities before this date' },
        },
      },
      limit: { type: 'number', description: 'Max activities to return (default 25, max 100)' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;

    if (action === 'list') {
      // Resolve project filter — always scope to a project
      let projectDocId: string = ctx.projectDocumentId;
      if (input.targetProjectSlug) {
        if (!ctx.crossProjectAccess) {
          return 'Error: crossProjectAccess required to view activities in other projects.';
        }
        const targetId = await resolveTargetProject(ctx.strapi, input.targetProjectSlug as string);
        if (!targetId) return `Error: project with slug "${input.targetProjectSlug}" not found`;
        projectDocId = targetId;
      }

      const filters: Record<string, any> = {};
      const f = input.filters as Record<string, string> | undefined;
      if (f?.type) filters.type = { $eq: f.type };
      if (f?.actor) filters.actor = { $containsi: f.actor };
      if (f?.after) filters.createdAt = { ...filters.createdAt, $gte: f.after };
      if (f?.before) filters.createdAt = { ...filters.createdAt, $lte: f.before };

      // Always scope to the resolved project via issue → project join
      filters.issue = { project: { documentId: { $eq: projectDocId } } };

      const reqLimit = Math.min(Math.max((input.limit as number) || 25, 1), 100);

      const activities: any[] = await ctx.strapi.documents(ACTIVITY_UID).findMany({
        filters,
        populate: {
          issue: { fields: ['documentId', 'id', 'title'] },
        },
        sort: { createdAt: 'desc' },
        limit: reqLimit,
      });

      return JSON.stringify(
        activities.map((a: any) => ({
          documentId: a.documentId,
          type: a.type,
          actor: a.actor,
          body: a.body,
          isAI: a.isAI || false,
          field: a.field || null,
          fromValue: a.fromValue || null,
          toValue: a.toValue || null,
          metadata: a.metadata || null,
          createdAt: a.createdAt,
          issue: a.issue ? {
            issueId: `ISS-${a.issue.id}`,
            documentId: a.issue.documentId,
            title: a.issue.title,
          } : null,
        })),
      );
    }

    return `Unknown action: ${action}`;
  },
};
