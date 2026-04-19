import { factories } from '@strapi/strapi';

// Cast UID — Strapi types are generated at build time; owner/members are new fields.
const UID = 'api::project.project' as any;

/** Pick safe user fields to avoid leaking sensitive data */
function safeUser(u: any) {
  if (!u) return null;
  return { id: u.id, documentId: u.documentId, username: u.username, email: u.email };
}

export default factories.createCoreController(UID, ({ strapi }) => {
  /** Returns true if the authenticated user owns the project, or responds with 403. */
  async function requireOwner(ctx: any): Promise<boolean> {
    if (!ctx.state.user) return true;
    const project: any = await strapi.documents(UID).findOne({
      documentId: ctx.params.id,
      populate: ['owner'],
    });
    if (project?.owner?.id === ctx.state.user.id) return true;
    ctx.forbidden('Only the project owner can perform this action');
    return false;
  }

  /** Fetch a project with user relations via document service (bypasses REST sanitizer) */
  async function getProjectWithUsers(documentId: string) {
    const p: any = await strapi.documents(UID).findOne({
      documentId,
      populate: ['owner', 'members', 'defaultDevice', 'devices', 'antigravityRunners', 'defaultAntigravityRunner'],
    });
    if (!p) return null;
    return {
      owner: safeUser(p.owner),
      members: (p.members ?? []).map(safeUser),
      defaultDevice: p.defaultDevice ?? null,
      devices: p.devices ?? [],
      antigravityRunners: p.antigravityRunners ?? [],
      defaultAntigravityRunner: p.defaultAntigravityRunner ?? null,
    };
  }

  /** Merge user relations into a REST response (Strapi strips users-permissions from REST output) */
  async function injectUserRelations(response: any) {
    if (!response) return response;
    const items = Array.isArray(response.data) ? response.data : [response.data];
    for (const item of items) {
      if (!item?.documentId) continue;
      const relations = await getProjectWithUsers(item.documentId);
      if (relations) Object.assign(item, relations);
    }
    return response;
  }

  return {
    // Auto-set owner on create
    async create(ctx) {
      const response = await super.create(ctx);
      // Set owner relation after creation via document service (REST body rejects relation fields)
      if (ctx.state.user && response?.data?.documentId) {
        await strapi.documents(UID).update({
          documentId: response.data.documentId,
          data: { owner: { connect: [ctx.state.user.documentId] } } as any,
        });
      }
      return injectUserRelations(response);
    },

    // Filter to owned/member projects for JWT users
    async find(ctx) {
      if (ctx.state.forgeProject || !ctx.state.user) {
        return injectUserRelations(await super.find(ctx));
      }
      const userId = ctx.state.user.id;

      // Query via document service to find which projects the user can access
      // (bypasses REST filter validation on user-permissions relations)
      const allProjects: any[] = await strapi.documents(UID).findMany({
        populate: ['owner', 'members'],
      });

      const userDocIds = allProjects
        .filter((p: any) => {
          if (p.owner?.id === userId) return true;
          if (p.members?.some((m: any) => m.id === userId)) return true;
          return false;
        })
        .map((p: any) => p.documentId);

      // No accessible projects — return empty immediately ($in: [] may return all in Strapi)
      if (userDocIds.length === 0) {
        return { data: [], meta: { pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 } } };
      }

      // Inject documentId filter, delegate to super.find for proper REST formatting
      ctx.query = {
        ...ctx.query,
        filters: {
          ...(ctx.query.filters as any),
          documentId: { $in: userDocIds },
        },
      };
      const response = await super.find(ctx);
      return injectUserRelations(response);
    },

    // Verify membership on findOne
    async findOne(ctx) {
      if (ctx.state.forgeProject || !ctx.state.user) {
        return injectUserRelations(await super.findOne(ctx));
      }
      const project: any = await strapi.documents(UID).findOne({
        documentId: ctx.params.id,
        populate: ['owner', 'members'],
      });
      if (!project) return ctx.notFound();
      const userId = ctx.state.user.id;
      const hasAccess =
        project.owner?.id === userId ||
        project.members?.some((m: any) => m.id === userId);
      if (!hasAccess) return ctx.notFound();
      const response = await super.findOne(ctx);
      return injectUserRelations(response);
    },

    async update(ctx) {
      if (!(await requireOwner(ctx))) return;

      // Handle relation fields (members, defaultDevice) that Strapi's REST validator rejects
      const body = (ctx.request.body as any)?.data ?? {};
      const relationData: any = {};
      for (const key of ['members', 'defaultDevice', 'devices', 'antigravityRunners', 'defaultAntigravityRunner']) {
        if (body[key] !== undefined) {
          relationData[key] = body[key];
          delete body[key];
        }
      }

      // Enforce antigravity runner project quota when connecting runners
      const runnerConnect = relationData.antigravityRunners?.connect;
      if (runnerConnect && Array.isArray(runnerConnect) && runnerConnect.length > 0) {
        const RUNNER_UID = 'api::antigravity-runner.antigravity-runner' as any;
        const allProjects: any[] = await strapi.documents(UID).findMany({
          populate: { antigravityRunners: { fields: ['documentId'] } },
          limit: 200,
        });

        for (const runnerDocId of runnerConnect) {
          const runner: any = await strapi.documents(RUNNER_UID).findOne({ documentId: runnerDocId });
          if (!runner) continue;
          const maxProjects = runner.maxProjects ?? 10;
          const currentCount = allProjects.filter((p: any) =>
            (p.antigravityRunners || []).some((r: any) => r.documentId === runnerDocId),
          ).length;
          if (currentCount >= maxProjects) {
            ctx.status = 400;
            ctx.body = { error: `Runner '${runner.name}' has reached its project limit (${maxProjects})` };
            return;
          }
        }
      }

      // If there are relation updates, apply them via document service
      if (Object.keys(relationData).length > 0) {
        const updatePayload: any = { data: {} };
        for (const [key, value] of Object.entries(relationData) as any[]) {
          if (value?.connect || value?.disconnect || value?.set) {
            updatePayload.data[key] = value;
          }
        }
        if (Object.keys(updatePayload.data).length > 0) {
          await strapi.documents(UID).update({
            documentId: ctx.params.id,
            ...updatePayload,
          });
        }
      }

      // If there are still scalar fields, let Strapi handle them normally
      if (Object.keys(body).length > 0) {
        const response = await super.update(ctx);
        return injectUserRelations(response);
      }

      // Return the updated project
      const response = await super.findOne(ctx);
      return injectUserRelations(response);
    },

    async delete(ctx) {
      if (!(await requireOwner(ctx))) return;
      return super.delete(ctx);
    },

    /**
     * GET /api/projects/health — Cross-project health metrics for CEO dashboard.
     * Returns pipeline throughput, status distribution, blockers, and escalations per project.
     */
    async health(ctx) {
      const ISSUE_UID = 'api::issue.issue';
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      let projects: any[] = await strapi.documents(UID).findMany({
        fields: ['documentId', 'name', 'slug', 'projectMeta'],
        populate: ['owner', 'members'],
        limit: 100,
      });

      // Non-CEO users only see health for projects they own or are members of
      if (!ctx.state.forgeProject && ctx.state.user && !ctx.state.user.isCEO) {
        const userId = ctx.state.user.id;
        projects = projects.filter((p: any) => {
          if (p.owner?.id === userId) return true;
          if (p.members?.some((m: any) => m.id === userId)) return true;
          return false;
        });
      }

      const healthData = await Promise.all(
        projects.map(async (project: any) => {
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

          // Pending escalations (issues in waiting with escalation comments)
          const pendingEscalations = issues.filter((i: any) => i.status === 'waiting').length;

          // Average cycle time (created → closed, for closed issues)
          let avgCycleTimeDays = 0;
          if (closed.length > 0) {
            const totalMs = closed.reduce((sum: number, i: any) => {
              return sum + (new Date(i.updatedAt).getTime() - new Date(i.createdAt).getTime());
            }, 0);
            avgCycleTimeDays = Math.round(totalMs / closed.length / (24 * 60 * 60 * 1000) * 10) / 10;
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
        }),
      );

      ctx.body = { data: healthData };
    },
  };
});
