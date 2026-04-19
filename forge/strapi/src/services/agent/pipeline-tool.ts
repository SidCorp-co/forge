import type { ForgeTool } from './tools';
import { isPipelinePaused, setPipelinePaused, dispatchAllQueued } from '../pipeline-utils';
import { onStatusChange, dispatchNextForProject, STEP_TOGGLES } from '../pipeline-orchestrator';
import { getHeartbeatState, getHeartbeatHistory, forceHeartbeatTick } from '../heartbeat';

const PROJECT_UID = 'api::project.project';
const SESSION_UID = 'api::agent-session.agent-session' as any;
const ISSUE_UID = 'api::issue.issue';

/** Resolve a target project by slug. Returns the project documentId or null. */
async function resolveTargetProject(strapi: any, slug: string): Promise<string | null> {
  const project = await strapi.documents(PROJECT_UID).findFirst({
    filters: { slug: { $eq: slug } },
    fields: ['documentId'],
  });
  return project?.documentId || null;
}

const STEP_TOGGLE_KEYS = [
  'autoTriage', 'autoClarify', 'autoPlan', 'autoCode',
  'autoReview', 'autoTest', 'autoFix', 'autoRelease',
];

export const forgePipeline: ForgeTool = {
  name: 'forge_pipeline',
  description: 'Pipeline control. Actions: status, pause, resume, trigger, queue, unstick, heartbeat-status, heartbeat-tick, heartbeat-history, heartbeat-config. Use targetProjectSlug for cross-project access.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'pause', 'resume', 'trigger', 'queue', 'unstick', 'heartbeat-status', 'heartbeat-tick', 'heartbeat-history', 'heartbeat-config'] },
      targetProjectSlug: { type: 'string', description: 'Optional: target a specific project by slug' },
      scope: { type: 'string', enum: ['global', 'project'], description: 'Scope for pause/resume. Default: project' },
      issueDocumentId: { type: 'string', description: 'For trigger action: issue to re-trigger pipeline step' },
      staleDays: { type: 'number', description: 'For unstick action: issues not updated for this many days are considered stale (default: 1). Use 0 to retrigger all regardless of age.' },
      heartbeatConfig: { type: 'object', description: 'For heartbeat-config action (set): { enabled?: boolean, intervalSeconds?: number, paused?: boolean, stages?: string[], maxRetries?: number }' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;
    const scope = (input.scope as string) || 'project';

    // Resolve target project
    let projectDocId = ctx.projectDocumentId;
    if (input.targetProjectSlug) {
      const isReadOnly = action === 'status' || action === 'queue';
      if (!isReadOnly && !ctx.crossProjectAccess) {
        return 'Error: cross-project write access denied. Enable crossProjectAccess to pause/resume/trigger across projects.';
      }
      const targetId = await resolveTargetProject(ctx.strapi, input.targetProjectSlug as string);
      if (!targetId) return `Error: project with slug "${input.targetProjectSlug}" not found`;
      projectDocId = targetId;
    }

    if (action === 'status') {
      const projects: any[] = await ctx.strapi.documents(PROJECT_UID).findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['documentId', 'slug', 'agentConfig', 'pipelineConfig'],
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';

      // Pipeline config lives in agentConfig.pipelineConfig (canonical location)
      const pipelineCfg = project.agentConfig?.pipelineConfig || {};
      const enabled = pipelineCfg.enabled !== false;

      const enabledSteps: string[] = [];
      const disabledSteps: string[] = [];
      for (const key of STEP_TOGGLE_KEYS) {
        const val = pipelineCfg[key];
        const isEnabled = typeof val === 'object' ? val?.enabled !== false : val !== false;
        if (isEnabled) enabledSteps.push(key);
        else disabledSteps.push(key);
      }

      // Count queued/running sessions
      const sessions: any[] = await ctx.strapi.documents(SESSION_UID).findMany({
        filters: {
          project: { documentId: { $eq: projectDocId } },
          status: { $in: ['queued', 'running'] },
        },
        fields: ['status'],
        limit: 200,
      });

      const queued = sessions.filter((s: any) => s.status === 'queued').length;
      const running = sessions.filter((s: any) => s.status === 'running').length;

      return JSON.stringify({
        globalPaused: isPipelinePaused(),
        project: {
          slug: project.slug,
          pipelineEnabled: enabled,
          enabledSteps,
          disabledSteps,
        },
        sessions: { queued, running },
      });
    }

    if (action === 'pause') {
      if (scope === 'global') {
        if (!ctx.crossProjectAccess) {
          return 'Error: cross-project access required to pause the global pipeline.';
        }
        await setPipelinePaused(ctx.strapi, true);
        return JSON.stringify({ status: 'paused', scope: 'global' });
      }

      // Per-project pause: set pipelineConfig.enabled = false
      const projects: any[] = await ctx.strapi.documents(PROJECT_UID).findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['agentConfig', 'pipelineConfig', 'slug'],
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';

      const pipelineCfg = project.agentConfig?.pipelineConfig || {};
      const updatedCfg = { ...pipelineCfg, enabled: false };

      // Write to agentConfig.pipelineConfig (where the orchestrator reads it)
      const agentConfig = { ...(project.agentConfig || {}), pipelineConfig: updatedCfg };
      await ctx.strapi.documents(PROJECT_UID).update({
        documentId: projectDocId,
        data: { agentConfig },
      });

      return JSON.stringify({ status: 'paused', scope: 'project', slug: project.slug });
    }

    if (action === 'resume') {
      if (scope === 'global') {
        if (!ctx.crossProjectAccess) {
          return 'Error: cross-project access required to resume the global pipeline.';
        }
        await setPipelinePaused(ctx.strapi, false);
        await dispatchAllQueued(ctx.strapi, 'mcp-resume');
        return JSON.stringify({ status: 'resumed', scope: 'global' });
      }

      // Per-project resume: set pipelineConfig.enabled = true
      const projects: any[] = await ctx.strapi.documents(PROJECT_UID).findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['agentConfig', 'pipelineConfig', 'slug'],
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';

      const pipelineCfg = project.agentConfig?.pipelineConfig || {};
      const updatedCfg = { ...pipelineCfg, enabled: true };

      const agentConfig = { ...(project.agentConfig || {}), pipelineConfig: updatedCfg };
      await ctx.strapi.documents(PROJECT_UID).update({
        documentId: projectDocId,
        data: { agentConfig },
      });

      // Dispatch queued sessions for this project after resuming
      setImmediate(() => {
        dispatchNextForProject(ctx.strapi, projectDocId, 'desktop');
        dispatchNextForProject(ctx.strapi, projectDocId, 'antigravity');
      });

      return JSON.stringify({ status: 'resumed', scope: 'project', slug: project.slug });
    }

    if (action === 'trigger') {
      const issueDocId = input.issueDocumentId as string;
      if (!issueDocId) return 'Error: issueDocumentId required for trigger action';

      // Validate the issue exists and get its status
      const issue = await ctx.strapi.documents(ISSUE_UID).findOne({
        documentId: issueDocId,
        populate: ['project'],
        fields: ['documentId', 'status'],
      }) as any;
      if (!issue) return 'Error: Issue not found';

      // Verify the issue belongs to the target project (or caller has cross-project access)
      if (issue.project?.documentId !== projectDocId && !ctx.crossProjectAccess) {
        return 'Error: issue does not belong to your project. Use targetProjectSlug or enable crossProjectAccess.';
      }

      // Check dependencies before triggering — surface a clear message if blocked
      if (issue.status === 'clarified' || issue.status === 'approved') {
        const { checkDependenciesResolved } = await import('../pipeline-utils');
        const depCheck = await checkDependenciesResolved(ctx.strapi, issueDocId);
        if (depCheck.blocked) {
          return JSON.stringify({
            ok: false,
            issueDocumentId: issueDocId,
            issueStatus: issue.status,
            blocked: true,
            pendingDependencies: depCheck.pendingIds,
            message: `Cannot trigger: blocked by unresolved dependencies (${depCheck.pendingIds.join(', ')}). Will resume automatically when all blockers are resolved.`,
          });
        }
      }

      const sessionId = await onStatusChange(ctx.strapi, issueDocId, issue.status, issue.status, true);
      return JSON.stringify({
        ok: true,
        issueDocumentId: issueDocId,
        issueStatus: issue.status,
        sessionDocumentId: sessionId || null,
        message: sessionId ? 'Pipeline step triggered' : 'No pipeline step applicable for current status',
      });
    }

    if (action === 'unstick') {
      const staleDays = typeof input.staleDays === 'number' ? input.staleDays : 1;
      const autoPipelineStatuses = Object.keys(STEP_TOGGLES);

      const filters: any = {
        project: { documentId: { $eq: projectDocId } },
        status: { $in: autoPipelineStatuses },
      };
      if (staleDays > 0) {
        const cutoff = new Date(Date.now() - staleDays * 86400000).toISOString();
        filters.updatedAt = { $lt: cutoff };
      }

      const issues: any[] = await ctx.strapi.documents(ISSUE_UID).findMany({
        filters,
        fields: ['documentId', 'id', 'status'],
        limit: 200,
      });

      const details: any[] = [];
      let triggered = 0;
      let skipped = 0;

      for (const issue of issues) {
        try {
          const sessionId = await onStatusChange(ctx.strapi, issue.documentId, issue.status, issue.status, true);
          if (sessionId) {
            triggered++;
            details.push({
              issueId: `ISS-${issue.id}`,
              documentId: issue.documentId,
              status: issue.status,
              step: STEP_TOGGLES[issue.status] || null,
              sessionDocumentId: sessionId,
            });
          } else {
            skipped++;
            details.push({
              issueId: `ISS-${issue.id}`,
              documentId: issue.documentId,
              status: issue.status,
              step: STEP_TOGGLES[issue.status] || null,
              sessionDocumentId: null,
              skipped: true,
            });
          }
        } catch (err: any) {
          skipped++;
          details.push({
            issueId: `ISS-${issue.id}`,
            documentId: issue.documentId,
            status: issue.status,
            error: err.message || String(err),
          });
        }
      }

      return JSON.stringify({ found: issues.length, triggered, skipped, details });
    }

    if (action === 'queue') {
      const sessions: any[] = await ctx.strapi.documents(SESSION_UID).findMany({
        filters: {
          project: { documentId: { $eq: projectDocId } },
          status: { $in: ['queued', 'running'] },
        },
        populate: { issues: { fields: ['documentId', 'id', 'title', 'status'] } },
        sort: { createdAt: 'asc' },
        limit: 50,
      });

      return JSON.stringify(
        sessions.map((s: any) => {
          const meta = s.metadata || {};
          const runner = meta.runner || 'desktop';
          const device = runner === 'antigravity'
            ? meta.antigravityRunnerName || meta.antigravityRunnerId || null
            : meta.deviceName || meta.deviceId || null;
          return {
            documentId: s.documentId,
            title: s.title,
            status: s.status,
            skill: meta.skill || s.skill || null,
            runner,
            device,
            createdAt: s.createdAt,
            issues: (s.issues || []).map((i: any) => ({
              issueId: `ISS-${i.id}`,
              documentId: i.documentId,
              title: i.title,
              status: i.status,
            })),
          };
        }),
      );
    }

    // ─── Heartbeat Actions ──────────────────────────────────────────────

    if (action === 'heartbeat-status') {
      const state = getHeartbeatState();
      // Also include project-level heartbeat config
      const projects: any[] = await ctx.strapi.documents(PROJECT_UID).findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['slug', 'heartbeatConfig'],
        limit: 1,
      });
      const project = projects[0] as any;
      return JSON.stringify({
        ...state,
        projectConfig: project?.heartbeatConfig || { enabled: false },
        projectSlug: project?.slug,
      });
    }

    if (action === 'heartbeat-tick') {
      const result = await forceHeartbeatTick(ctx.strapi);
      return JSON.stringify(result);
    }

    if (action === 'heartbeat-history') {
      const history = getHeartbeatHistory();
      return JSON.stringify(history.slice(-10));
    }

    if (action === 'heartbeat-config') {
      const projects: any[] = await ctx.strapi.documents(PROJECT_UID).findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['slug', 'heartbeatConfig'],
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';

      // If no heartbeatConfig input, return current config (GET)
      if (!input.heartbeatConfig) {
        return JSON.stringify({ heartbeatConfig: project.heartbeatConfig || { enabled: false }, slug: project.slug });
      }

      // SET: merge input into existing config
      const existing = project.heartbeatConfig || {};
      const patch = input.heartbeatConfig as Record<string, any>;
      const updated = { ...existing, ...patch };

      await ctx.strapi.documents(PROJECT_UID).update({
        documentId: projectDocId,
        data: { heartbeatConfig: updated },
      });

      return JSON.stringify({ ok: true, heartbeatConfig: updated, slug: project.slug });
    }

    return `Unknown action: ${action}`;
  },
};
