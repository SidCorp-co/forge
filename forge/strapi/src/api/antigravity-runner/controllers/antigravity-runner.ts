/**
 * Antigravity Runner CRUD controller.
 * Manages registration, listing, updating, and deletion of runner instances.
 */

import * as antigravity from '../../../services/antigravity';
import { getQuotaCacheForRunner, refreshRunnerQuota } from '../../../services/antigravity-quota';

const RUNNER_UID = 'api::antigravity-runner.antigravity-runner' as any;
const PROJECT_UID_CTRL = 'api::project.project' as any;

/** Count how many projects are assigned to a runner via the M2M relation. */
async function countRunnerProjects(runnerDocId: string): Promise<number> {
  const projects = await strapi.documents(PROJECT_UID_CTRL).findMany({
    populate: { antigravityRunners: { fields: ['documentId'] } },
    limit: 200,
  });
  return projects.filter((p: any) =>
    (p.antigravityRunners || []).some((r: any) => r.documentId === runnerDocId),
  ).length;
}

export default {
  /** List all registered runners with their status, quota, project count, and mapped projects. */
  async find(ctx: any) {
    const runners = await strapi.documents(RUNNER_UID).findMany({
      limit: 100,
      sort: 'name:asc',
    });

    const forgeProjects = await strapi.documents(PROJECT_UID_CTRL).findMany({
      populate: { antigravityRunners: { fields: ['documentId'] } },
      limit: 200,
    });

    // Build lookup: AG projectId → Forge project { name, slug }
    // Use antigravityProjectMap (per-runner mapping) when available, fall back to legacy antigravityProjectId
    const agToForge = new Map<string, { name: string; slug: string }>();
    for (const p of forgeProjects) {
      const info = { name: (p as any).name, slug: (p as any).slug };
      const projectMap = (p as any).antigravityProjectMap as Record<string, string> | null;
      const hasMapEntries = projectMap && Object.values(projectMap).some((v) => !!v);
      if (hasMapEntries) {
        for (const agId of Object.values(projectMap!)) {
          if (agId) agToForge.set(agId, info);
        }
      } else if ((p as any).antigravityProjectId) {
        agToForge.set((p as any).antigravityProjectId, info);
      }
    }

    // Fetch AG project lists per runner in parallel
    const agProjectsByRunner = new Map<string, Array<{ projectId: string; agentId?: string }>>();
    try {
      const allAgProjects = await antigravity.listProjects();
      if (allAgProjects.projects) {
        for (const runner of runners) {
          const filtered = (runner as any).agentId
            ? allAgProjects.projects.filter((p: any) => p.agentId === (runner as any).agentId)
            : [];
          agProjectsByRunner.set((runner as any).documentId, filtered);
        }
      }
    } catch {
      // AG service unavailable — skip project lists
    }

    const data = runners.map((r: any) => {
      const agProjects = agProjectsByRunner.get(r.documentId) ?? [];
      const projectCount = agProjects.length;
      const projects = agProjects.map((ap: any) => ({
        projectId: ap.projectId,
        forgeProject: agToForge.get(ap.projectId) ?? null,
      }));

      return {
        ...r,
        projectCount,
        projects,
        quota: getQuotaCacheForRunner(r.documentId),
      };
    });

    ctx.body = { data };
  },

  /** Get a single runner by documentId. */
  async findOne(ctx: any) {
    const { id } = ctx.params;
    const runner = await strapi.documents(RUNNER_UID).findOne({ documentId: id });
    if (!runner) {
      ctx.status = 404;
      ctx.body = { error: 'Runner not found' };
      return;
    }
    const projectCount = await countRunnerProjects(id);
    ctx.body = {
      data: {
        ...runner,
        projectCount,
        quota: getQuotaCacheForRunner(runner.documentId),
      },
    };
  },

  /** Register a new runner. */
  async create(ctx: any) {
    const { name, endpoint, agentId } = ctx.request.body?.data || ctx.request.body || {};
    if (!name) {
      ctx.status = 400;
      ctx.body = { error: 'name is required' };
      return;
    }

    // Normalize endpoint — strip trailing slash
    const cleanEndpoint = endpoint ? endpoint.replace(/\/+$/, '') : undefined;

    // Check for duplicate by agentId if provided
    if (agentId) {
      const existing = await strapi.documents(RUNNER_UID).findMany({
        filters: { agentId: { $eq: agentId } },
        limit: 1,
      });
      if (existing.length > 0) {
        ctx.status = 409;
        ctx.body = { error: 'A runner with this agentId already exists', data: existing[0] };
        return;
      }
    }

    const createData: any = { name, status: 'offline' };
    if (cleanEndpoint) createData.endpoint = cleanEndpoint;
    if (agentId) createData.agentId = agentId;

    const runner = await strapi.documents(RUNNER_UID).create({
      data: createData,
    });

    // Trigger immediate health check
    const { checkRunnerHealth } = await import('../../../services/antigravity-runner-pool');
    setImmediate(() => {
      checkRunnerHealth(runner).catch(() => {});
    });

    ctx.status = 201;
    ctx.body = { data: runner };
  },

  /** Update a runner (name, endpoint, maxProjects, agentId, excluded). */
  async update(ctx: any) {
    const { id } = ctx.params;
    const { name, endpoint, maxProjects, agentId, excluded } = ctx.request.body?.data || ctx.request.body || {};

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (endpoint !== undefined) updateData.endpoint = endpoint.replace(/\/+$/, '');
    if (maxProjects !== undefined) updateData.maxProjects = maxProjects;
    if (agentId !== undefined) updateData.agentId = agentId;
    if (excluded !== undefined) updateData.excluded = !!excluded;

    const runner = await strapi.documents(RUNNER_UID).update({
      documentId: id,
      data: updateData,
    });

    if (!runner) {
      ctx.status = 404;
      ctx.body = { error: 'Runner not found' };
      return;
    }

    ctx.body = { data: runner };
  },

  /** Delete a runner. Cascade-cleans project associations. */
  async delete(ctx: any) {
    const { id } = ctx.params;

    // Remove from all project pools
    const PROJECT_UID = 'api::project.project' as any;
    const projects = await strapi.documents(PROJECT_UID).findMany({
      populate: { antigravityRunners: true, defaultAntigravityRunner: true },
      limit: 200,
    });

    for (const project of projects) {
      const runners: any[] = (project as any).antigravityRunners || [];
      const isInPool = runners.some((r: any) => r.documentId === id);
      const isDefault = (project as any).defaultAntigravityRunner?.documentId === id;

      if (isInPool || isDefault) {
        // Update JSON fields via document service
        const updates: any = {};
        if (isDefault) {
          updates.defaultAntigravityRunner = null;
        }
        const projectMap = { ...((project as any).antigravityProjectMap || {}) };
        delete projectMap[id];
        updates.antigravityProjectMap = projectMap;

        await strapi.documents(PROJECT_UID).update({
          documentId: project.documentId,
          data: updates,
        });

        // M2M disconnect via entityService (document service ignores M2M connect/disconnect)
        if (isInPool) {
          const runnerRecord = runners.find((r: any) => r.documentId === id);
          if (runnerRecord) {
            await strapi.entityService.update(PROJECT_UID, (project as any).id, {
              data: {
                antigravityRunners: { disconnect: [runnerRecord.id] },
              },
            });
          }
        }
      }
    }

    await strapi.documents(RUNNER_UID).delete({ documentId: id });
    ctx.body = { data: { ok: true } };
  },

  /** Force health check on a specific runner. */
  async healthCheck(ctx: any) {
    const { id } = ctx.params;
    const runner = await strapi.documents(RUNNER_UID).findOne({ documentId: id });
    if (!runner) {
      ctx.status = 404;
      ctx.body = { error: 'Runner not found' };
      return;
    }

    const { checkRunnerHealth } = await import('../../../services/antigravity-runner-pool');
    await checkRunnerHealth(runner);

    const updated = await strapi.documents(RUNNER_UID).findOne({ documentId: id });
    ctx.body = { data: updated };
  },

  /** Get quota for a specific runner. */
  async getQuota(ctx: any) {
    const { id } = ctx.params;
    const runner = await strapi.documents(RUNNER_UID).findOne({ documentId: id });
    if (!runner) {
      ctx.status = 404;
      ctx.body = { error: 'Runner not found' };
      return;
    }

    ctx.body = { data: getQuotaCacheForRunner(id) };
  },

  /** Force refresh quota for a specific runner. */
  async refreshQuota(ctx: any) {
    const { id } = ctx.params;
    const runner: any = await strapi.documents(RUNNER_UID).findOne({ documentId: id });
    if (!runner) {
      ctx.status = 404;
      ctx.body = { error: 'Runner not found' };
      return;
    }

    const result = await refreshRunnerQuota(id, runner.endpoint || undefined);
    ctx.body = { data: result };
  },

  /** List projects on a specific runner's Antigravity instance. */
  async listRunnerProjects(ctx: any) {
    const { id } = ctx.params;
    const runner: any = await strapi.documents(RUNNER_UID).findOne({ documentId: id });
    if (!runner) {
      ctx.status = 404;
      ctx.body = { error: 'Runner not found' };
      return;
    }

    try {
      const allProjects = await antigravity.listProjects();
      // Filter by runner's agentId if available
      if (runner.agentId && allProjects.projects) {
        const filtered = allProjects.projects.filter((p: any) => p.agentId === runner.agentId);
        ctx.body = { data: { total: filtered.length, projects: filtered } };
      } else {
        ctx.body = { data: allProjects };
      }
    } catch (err: any) {
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },

  /** Exclude a runner from the active pool. Proactively pauses affected projects. */
  async exclude(ctx: any) {
    const { id } = ctx.params;
    const runner = await strapi.documents(RUNNER_UID).update({
      documentId: id,
      data: { excluded: true },
    });
    if (!runner) {
      ctx.status = 404;
      ctx.body = { error: 'Runner not found' };
      return;
    }

    // Proactively pause projects that no longer have available runners
    const { checkAntigravityReady, pauseProjectAntigravity } = await import('../../../services/antigravity-runner-pool');
    const projects = await strapi.documents(PROJECT_UID_CTRL).findMany({
      populate: { antigravityRunners: { fields: ['documentId'] } },
      limit: 200,
    });
    for (const project of projects) {
      const inPool = ((project as any).antigravityRunners || []).some((r: any) => r.documentId === id);
      if (!inPool) continue;
      const readiness = await checkAntigravityReady(project.documentId);
      if (!readiness.ready) {
        await pauseProjectAntigravity(project.documentId, readiness.error || 'Runner excluded from pool');
      }
    }

    ctx.body = { data: runner };
  },

  /** Include a runner back into the active pool. Clears errors on affected projects. */
  async include(ctx: any) {
    const { id } = ctx.params;
    const runner = await strapi.documents(RUNNER_UID).update({
      documentId: id,
      data: { excluded: false },
    });
    if (!runner) {
      ctx.status = 404;
      ctx.body = { error: 'Runner not found' };
      return;
    }

    // Resume projects that were paused due to exclusion
    const { checkAntigravityReady, clearProjectAntigravityError } = await import('../../../services/antigravity-runner-pool');
    const projects = await strapi.documents(PROJECT_UID_CTRL).findMany({
      fields: ['agentConfig'],
      populate: { antigravityRunners: { fields: ['documentId'] } },
      limit: 200,
    });
    for (const project of projects) {
      const inPool = ((project as any).antigravityRunners || []).some((r: any) => r.documentId === id);
      const hasError = (project as any).agentConfig?.antigravityError;
      if (!inPool || !hasError) continue;
      const readiness = await checkAntigravityReady(project.documentId);
      if (readiness.ready) {
        await clearProjectAntigravityError(project.documentId);
        try {
          const { dispatchNextForProject } = await import('../../../services/pipeline-orchestrator');
          await dispatchNextForProject(strapi, project.documentId, 'antigravity');
        } catch { /* ignore */ }
      }
    }

    ctx.body = { data: runner };
  },

  /** Clear depleted models on a runner (manual quota reset). */
  async clearDepletedModels(ctx: any) {
    const { id } = ctx.params;
    const runner = await strapi.documents(RUNNER_UID).update({
      documentId: id,
      data: { depletedModels: {} },
    });
    if (!runner) {
      ctx.status = 404;
      ctx.body = { error: 'Runner not found' };
      return;
    }
    strapi.log.info(`[antigravity-runner] Cleared depleted models for runner ${id}`);
    ctx.body = { data: runner };
  },

  /** Clear the pause on a runner, making it immediately available. */
  async clearPause(ctx: any) {
    const { id } = ctx.params;
    const { clearRunnerPause } = await import('../../../services/antigravity-runner-pool');
    await clearRunnerPause(id);
    const runner = await strapi.documents(RUNNER_UID).findOne({ documentId: id });
    if (!runner) {
      ctx.status = 404;
      ctx.body = { error: 'Runner not found' };
      return;
    }
    ctx.body = { data: runner };
  },

  /** Sync runners from proxy /agents — discover new agents, update existing. */
  async syncAgents(ctx: any) {
    try {
      const { bootstrapRunners } = await import('../../../services/antigravity-runner-pool');
      await bootstrapRunners();
      // Return updated runner list
      const runners = await strapi.documents(RUNNER_UID).findMany({ limit: 100, sort: 'name:asc' });
      ctx.body = { data: runners };
    } catch (err: any) {
      strapi.log.error(`[antigravity-runner] syncAgents error: ${err.message}`);
      ctx.status = 502;
      ctx.body = { error: err.message };
    }
  },
};

// Re-export checkRunnerHealth so the controller can call it
// (the function is defined in the service, we import it dynamically above)
