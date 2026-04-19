import type { ForgeTool } from './tools';

/** Resolve a target project by slug. Returns the project documentId or null. */
async function resolveTargetProject(strapi: any, slug: string): Promise<string | null> {
  const project = await strapi.documents('api::project.project').findFirst({
    filters: { slug: { $eq: slug } },
    fields: ['documentId'],
  });
  return project?.documentId || null;
}

const ISSUE_UID = 'api::issue.issue';
const PROJECT_UID = 'api::project.project';

async function computeProjectHealth(strapi: any, project: any): Promise<Record<string, any>> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const issues: any[] = await strapi.documents(ISSUE_UID).findMany({
    filters: {
      project: { documentId: { $eq: project.documentId } },
      updatedAt: { $gte: thirtyDaysAgo },
    },
    fields: ['documentId', 'id', 'status', 'priority', 'relations', 'createdAt', 'updatedAt'],
    limit: 500,
  });

  // Status distribution
  const statusDistribution: Record<string, number> = {};
  for (const issue of issues) {
    statusDistribution[issue.status] = (statusDistribution[issue.status] || 0) + 1;
  }

  // Throughput: issues that reached 'closed' in last 30 days
  const closed = issues.filter((i: any) => i.status === 'closed');
  const throughput = Math.round((closed.length / 30) * 7); // per week

  // Active blockers
  const blockers = issues.filter((i: any) => {
    if (!['confirmed', 'clarified', 'approved'].includes(i.status)) return false;
    const relations: any[] = Array.isArray(i.relations) ? i.relations : [];
    return relations.some((r: any) => r.type === 'blocked_by' || r.type === 'depends_on');
  });

  // Pending escalations
  const pendingEscalations = issues.filter((i: any) => i.status === 'waiting').length;

  // Average cycle time (created → closed)
  let avgCycleTimeDays = 0;
  if (closed.length > 0) {
    const totalMs = closed.reduce((sum: number, i: any) => {
      return sum + (new Date(i.updatedAt).getTime() - new Date(i.createdAt).getTime());
    }, 0);
    avgCycleTimeDays = Math.round((totalMs / closed.length / (24 * 60 * 60 * 1000)) * 10) / 10;
  }

  return {
    projectName: project.name,
    projectSlug: project.slug,
    projectMeta: project.projectMeta || {},
    throughput,
    totalActive: issues.filter((i: any) => !['closed', 'released'].includes(i.status)).length,
    statusDistribution,
    blockers: blockers.map((i: any) => ({
      issueId: `ISS-${i.id}`,
      documentId: i.documentId,
      status: i.status,
    })),
    pendingEscalations,
    avgCycleTimeDays,
  };
}

export const forgeHealth: ForgeTool = {
  name: 'forge_health',
  description: 'Cross-project health metrics. Actions: summary (all projects), project (one project by targetProjectSlug or current).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['summary', 'project'] },
      targetProjectSlug: { type: 'string', description: 'Optional: get health for a specific project by slug' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;
    const docs = ctx.strapi.documents(PROJECT_UID);

    if (action === 'summary') {
      // Cross-project summary requires crossProjectAccess; otherwise return only current project
      if (!ctx.crossProjectAccess) {
        const projects: any[] = await docs.findMany({
          filters: { documentId: { $eq: ctx.projectDocumentId } },
          fields: ['documentId', 'name', 'slug', 'projectMeta'],
          limit: 1,
        });
        if (!projects[0]) return 'Error: Project not found';
        return JSON.stringify([await computeProjectHealth(ctx.strapi, projects[0])]);
      }

      const projects: any[] = await docs.findMany({
        fields: ['documentId', 'name', 'slug', 'projectMeta'],
        limit: 100,
      });

      const healthData = await Promise.all(
        projects.map((project: any) => computeProjectHealth(ctx.strapi, project)),
      );

      return JSON.stringify(healthData);
    }

    if (action === 'project') {
      let projectDocId = ctx.projectDocumentId;
      if (input.targetProjectSlug) {
        if (!ctx.crossProjectAccess) {
          return 'Error: crossProjectAccess required to view health metrics for other projects.';
        }
        const targetId = await resolveTargetProject(ctx.strapi, input.targetProjectSlug as string);
        if (!targetId) return `Error: project with slug "${input.targetProjectSlug}" not found`;
        projectDocId = targetId;
      }

      const projects: any[] = await docs.findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['documentId', 'name', 'slug', 'projectMeta'],
        limit: 1,
      });
      const project = projects[0];
      if (!project) return 'Error: Project not found';

      return JSON.stringify(await computeProjectHealth(ctx.strapi, project));
    }

    return `Unknown action: ${action}`;
  },
};
