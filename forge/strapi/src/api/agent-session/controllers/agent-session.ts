import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { find, findOne } from '../handlers/session-crud';
import { start, send, abort } from '../handlers/session-lifecycle';
import { relay, buildPrompt, promptBuilt, registerDeviceHandler, unregisterDeviceHandler, deviceStatus, indexCodebase } from '../handlers/desktop-relay';
import { onStatusChange as triggerPipelineStep } from '../../../services/pipeline-orchestrator';
import { getPipelineControlState, setPipelinePaused, dispatchAllQueued, pipelineTelemetry, SESSION_UID } from '../../../services/pipeline-utils';
import { isDeviceConnected } from '../../../services/websocket';

// Cast UID — Strapi types are generated at build time; this content type is new.
const UID = 'api::agent-session.agent-session' as any;

export default factories.createCoreController(UID, ({ strapi }) => ({
  async find(ctx: Context) { return find(ctx, strapi); },
  async findOne(ctx: Context) { return findOne(ctx, strapi); },
  async start(ctx: Context) { return start(ctx, strapi); },
  async send(ctx: Context) { return send(ctx, strapi); },
  async abort(ctx: Context) { return abort(ctx, strapi); },
  async relay(ctx: Context) { return relay(ctx, strapi); },
  async buildPrompt(ctx: Context) { return buildPrompt(ctx, strapi); },
  async promptBuilt(ctx: Context) { return promptBuilt(ctx, strapi); },
  async update(ctx: Context) {
    const { id } = ctx.params;
    const { data } = ctx.request.body as any;
    if (!data) { ctx.status = 400; ctx.body = { error: 'data required' }; return; }
    const allowed = ['usage', 'title', 'status', 'metadata'];
    const update: Record<string, any> = {};
    for (const key of allowed) { if (data[key] !== undefined) update[key] = data[key]; }
    const result = await strapi.documents(UID).update({ documentId: id, data: update });
    ctx.body = { data: result };
  },

  async registerDesktop(ctx: Context) { return registerDeviceHandler(ctx); },
  async unregisterDesktop(ctx: Context) { return unregisterDeviceHandler(ctx); },
  async desktopStatus(ctx: Context) { return deviceStatus(ctx, strapi); },
  async indexCodebase(ctx: Context) { return indexCodebase(ctx, strapi); },

  /**
   * Manually trigger a pipeline step for an issue.
   * Used when the issue is already at the target status (e.g. open → triage)
   * and the UI wants to kick off the Antigravity/desktop agent.
   */
  async triggerPipeline(ctx: Context) {
    const { issueDocumentId } = ctx.request.body as any;
    if (!issueDocumentId) {
      ctx.status = 400;
      ctx.body = { error: 'issueDocumentId required' };
      return;
    }

    const issue = await strapi.documents('api::issue.issue' as any).findOne({
      documentId: issueDocumentId,
      fields: ['status', 'relations'],
    });

    if (!issue) {
      ctx.status = 404;
      ctx.body = { error: 'Issue not found' };
      return;
    }

    // Check dependencies before triggering — return clear message for UI popup
    if (issue.status === 'clarified' || issue.status === 'approved') {
      const { checkDependenciesResolved } = await import('../../../services/pipeline-utils');
      const depCheck = await checkDependenciesResolved(strapi, issueDocumentId);
      if (depCheck.blocked) {
        ctx.status = 422;
        ctx.body = {
          error: `Blocked by unresolved dependencies: ${depCheck.pendingIds.join(', ')}. Will resume automatically when all blockers are resolved.`,
          blocked: true,
          pendingDependencies: depCheck.pendingIds,
        };
        return;
      }
    }

    // Trigger pipeline — manual=true skips per-step auto-enable check
    // Await to get the session ID back for the UI to open the chat panel.
    let sessionDocumentId: string | null = null;
    try {
      sessionDocumentId = await triggerPipelineStep(strapi, issueDocumentId, issue.status, issue.status, true);
    } catch (err: any) {
      strapi.log.warn(`[pipeline] manual trigger failed for ${issueDocumentId}: ${err.message}`);
    }

    if (!sessionDocumentId) {
      ctx.status = 422;
      ctx.body = { error: `No pipeline skill for status "${issue.status}"` };
      return;
    }

    ctx.body = { data: { ok: true, status: issue.status, sessionDocumentId } };
  },

  /** Get pipeline control state (paused/running). */
  async getPipelineControl(ctx: Context) {
    ctx.body = { data: getPipelineControlState() };
  },

  /** Set pipeline control state. POST { paused: true/false } */
  async setPipelineControl(ctx: Context) {
    const { paused } = ctx.request.body as any;
    if (typeof paused !== 'boolean') {
      ctx.status = 400;
      ctx.body = { error: 'paused (boolean) required' };
      return;
    }

    const wasPaused = getPipelineControlState().paused;
    await setPipelinePaused(strapi, paused);
    strapi.log.info(`[pipeline] Pipeline ${paused ? 'PAUSED' : 'RESUMED'} via API`);

    // When resuming, dispatch all queued sessions
    if (wasPaused && !paused) {
      setImmediate(() => {
        dispatchAllQueued(strapi, 'pipeline-resume').catch((err: any) =>
          strapi.log.warn(`[pipeline] Resume dispatch failed: ${err.message}`),
        );
      });
    }

    ctx.body = { data: { paused } };
  },

  /** Pipeline telemetry — returns raw in-memory counters (no DB queries). */
  async pipelineTelemetry(ctx: Context) {
    ctx.body = pipelineTelemetry;
  },

  /** Pipeline health dashboard — aggregates session recovery stats from DB + in-memory telemetry. */
  async pipelineHealth(ctx: Context) {
    const windowHours = parseInt((ctx.query.window as string) || '24', 10);
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

    // Query all sessions within time window — filter pipeline type in JS
    const allSessions = await strapi.documents(SESSION_UID).findMany({
      filters: { createdAt: { $gte: since } },
      fields: ['status', 'metadata', 'createdAt', 'updatedAt'],
      limit: 500,
    });
    const sessions = allSessions.filter((s: any) => s.metadata?.type === 'pipeline');

    // Aggregate session counts
    const counts = { total: 0, completed: 0, completedByVerification: 0, failed: 0, queued: 0, running: 0 };
    const bySkill: Record<string, { completed: number; recovered: number; failed: number }> = {};
    const recovery = { recovered: 0, recoveredBy: {} as Record<string, number>, failedAfterCheck: 0, autoRetries: 0, retriesExhausted: 0 };

    for (const s of sessions) {
      counts.total++;
      if (s.status === 'completed') counts.completed++;
      if (s.status === 'failed') counts.failed++;
      if (s.status === 'queued') counts.queued++;
      if (s.status === 'running') counts.running++;

      const meta = s.metadata || {};
      if (meta.completedByVerification) counts.completedByVerification++;

      // Per-skill breakdown
      const skill = meta.skill || 'unknown';
      if (!bySkill[skill]) bySkill[skill] = { completed: 0, recovered: 0, failed: 0 };
      if (s.status === 'completed') bySkill[skill].completed++;
      if (meta.completedByVerification || meta.recoveredBy) bySkill[skill].recovered++;
      if (s.status === 'failed') bySkill[skill].failed++;

      // Recovery stats from DB-persisted metadata
      if (meta.completedByVerification) {
        recovery.recovered++;
        const rTag = meta.recoveredBy || 'unknown';
        recovery.recoveredBy[rTag] = (recovery.recoveredBy[rTag] || 0) + 1;
      }
      if (meta.recoveryOutcome === 'failed') recovery.failedAfterCheck++;
      if (meta.autoRetried) recovery.autoRetries++;
      if (meta.retriesExhausted) recovery.retriesExhausted++;
    }

    // ── Stuck detection ──
    const ISSUE_UID = 'api::issue.issue' as any;

    // 1. Stale sessions that slipped past watcher (running >30min with no update)
    const staleThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const staleRunningSessions = await strapi.documents(SESSION_UID).findMany({
      filters: { status: 'running', updatedAt: { $lt: staleThreshold } },
      fields: ['documentId', 'title', 'metadata', 'updatedAt'],
      limit: 50,
    });
    const staleSessions = staleRunningSessions.filter((s: any) => s.metadata?.type === 'pipeline');

    // 2. Orphaned in_progress issues with no active session
    const inProgressIssues = await strapi.documents(ISSUE_UID).findMany({
      filters: { status: 'in_progress' },
      fields: ['documentId', 'id', 'updatedAt'],
      limit: 100,
    });
    const orphanedIssues: any[] = [];
    for (const issue of inProgressIssues) {
      const activeSessions = await strapi.documents(SESSION_UID).findMany({
        filters: {
          issues: { documentId: { $eq: issue.documentId } },
          status: { $in: ['running', 'queued'] },
        },
        fields: ['documentId'],
        limit: 1,
      });
      if (activeSessions.length === 0) {
        orphanedIssues.push({ issueId: issue.id, documentId: issue.documentId, updatedAt: issue.updatedAt });
      }
    }

    // 3. Queued sessions stuck >1hr
    const queuedThreshold = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stuckQueuedAll = await strapi.documents(SESSION_UID).findMany({
      filters: { status: 'queued', createdAt: { $lt: queuedThreshold } },
      fields: ['documentId', 'title', 'metadata', 'createdAt'],
      limit: 50,
    });
    const stuckQueued = stuckQueuedAll.filter((s: any) => s.metadata?.type === 'pipeline');

    // 4. Failed sessions with no auto-retry (within window)
    const failedNoRetry = sessions.filter(
      (s: any) => s.status === 'failed' && s.metadata?.recoveryOutcome === 'failed' && !s.metadata?.autoRetried,
    );

    // ── Missed triggers: issues at auto-enabled statuses with no active session (per project) ──
    const STEP_TOGGLES: Record<string, string> = {
      open: 'autoTriage', confirmed: 'autoClarify', clarified: 'autoPlan',
      approved: 'autoCode', developed: 'autoReview', testing: 'autoTest',
      reopen: 'autoFix', released: 'autoRelease',
    };
    const SKILL_NAMES: Record<string, string> = {
      open: 'forge-triage', confirmed: 'forge-clarify', clarified: 'forge-plan',
      approved: 'forge-code', developed: 'forge-review', testing: 'forge-test',
      reopen: 'forge-fix', released: 'forge-release',
    };
    const triggerStatuses = Object.keys(STEP_TOGGLES);

    const PROJECT_UID = 'api::project.project' as any;
    const projects = await strapi.documents(PROJECT_UID).findMany({
      fields: ['name', 'slug', 'agentConfig'],
      limit: 100,
    });

    const byProject: Record<string, any> = {};
    for (const project of projects) {
      const pc = project.agentConfig?.pipelineConfig || { enabled: false };
      const enabledSteps: string[] = [];
      const disabledSteps: string[] = [];
      for (const [status, toggle] of Object.entries(STEP_TOGGLES)) {
        const stepVal = pc[toggle];
        const enabled = pc.enabled && (
          stepVal === true || (typeof stepVal === 'object' && stepVal?.enabled !== false)
        );
        (enabled ? enabledSteps : disabledSteps).push(status);
      }

      // Find issues at trigger statuses for this project with no active session
      const missedTriggers: any[] = [];
      if (pc.enabled && enabledSteps.length > 0) {
        const issuesAtTrigger = await strapi.documents(ISSUE_UID).findMany({
          filters: {
            project: { documentId: { $eq: project.documentId } },
            status: { $in: enabledSteps },
          },
          fields: ['documentId', 'id', 'status', 'title', 'updatedAt'],
          limit: 50,
        });

        for (const issue of issuesAtTrigger) {
          // Skip in_progress — that means agent is working
          if (issue.status === 'in_progress') continue;
          const activeSessions = await strapi.documents(SESSION_UID).findMany({
            filters: {
              issues: { documentId: { $eq: issue.documentId } },
              status: { $in: ['running', 'queued'] },
            },
            fields: ['documentId'],
            limit: 1,
          });
          if (activeSessions.length === 0) {
            missedTriggers.push({
              issueId: issue.id,
              documentId: issue.documentId,
              title: issue.title,
              status: issue.status,
              expectedSkill: SKILL_NAMES[issue.status] || 'unknown',
              updatedAt: issue.updatedAt,
            });
          }
        }
      }

      // Count sessions for this project within window
      const projectSessions = sessions.filter(
        (s: any) => s.metadata?.projectDocumentId === project.documentId,
      );

      // Only include projects that have issues (sessions in window or missed triggers)
      if (projectSessions.length > 0 || missedTriggers.length > 0) {
        byProject[project.slug || project.documentId] = {
          name: project.name,
          slug: project.slug,
          pipelineEnabled: !!pc.enabled,
          enabledSteps,
          disabledSteps,
          sessionsInWindow: projectSessions.length,
          missedTriggers,
        };
      }
    }

    // ── Desktop devices status ──
    const DEVICE_UID = 'api::device.device' as any;
    const allDevices = await strapi.documents(DEVICE_UID).findMany({
      fields: ['name', 'deviceId', 'lastSeen'],
      limit: 50,
    });
    const desktopDevices = allDevices.map((d: any) => ({
      name: d.name || d.deviceId,
      deviceId: d.deviceId,
      status: isDeviceConnected(d.deviceId) ? 'online' : 'offline',
      lastSeen: d.lastSeen,
    }));

    ctx.body = {
      window: `${windowHours}h`,
      sessions: counts,
      recovery,
      bySkill,
      staleWatcher: pipelineTelemetry.staleWatcher,
      stuck: {
        staleSessions: staleSessions.map((s: any) => ({ id: s.documentId, title: s.title, updatedAt: s.updatedAt })),
        orphanedInProgress: orphanedIssues,
        queuedOverOneHour: stuckQueued.map((s: any) => ({ id: s.documentId, title: s.title, createdAt: s.createdAt })),
        failedNoRetry: failedNoRetry.length,
      },
      inProgressStuck: orphanedIssues.length,
      byProject,
      desktopDevices,
    };
  },
}));
