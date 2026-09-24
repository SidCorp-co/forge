// The composition root: mount every domain's routes, run the start sequence, serve, wind down.

import './observability/sentry-init.js';
import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { adminAggregateRoutes } from './admin/aggregate-routes.js';
import { adminAlertRoutes } from './admin/alert-routes.js';
import { adminMcpAuditRoutes } from './admin/mcp-audit-routes.js';
import { adminMetricSeriesRoutes } from './admin/metric-series-routes.js';
import { pipelineHealthAdminRoutes } from './admin/pipeline-health-routes.js';
import { adminRoutes } from './admin/routes.js';
import { adminThresholdRoutes } from './admin/thresholds-routes.js';
import { agentSessionAttachmentRoutes } from './agent-sessions/attachment-routes.js';
import { agentSessionProjectReadRoutes } from './agent-sessions/project-read-routes.js';
import { agentSessionRoutes } from './agent-sessions/routes.js';
import { registerAgentCronTicker, unregisterAgentCronTicker } from './agents/cron.js';
import { agentRoutes } from './agents/routes.js';
import { memoryModelRoutes } from './app-config/memory-model-routes.js';
import { appConfigRoutes } from './app-config/routes.js';
import { registerWebConversationAdapter } from './assistant/conversation-drain.js';
import { registerTranscriptIndexSweeper } from './assistant/conversation-index-drain.js';
import { conversationRoutes } from './assistant/conversation-routes.js';
import { speakerLinkMeRoutes, speakerLinkProjectRoutes } from './assistant/identity/routes.js';
import { bootstrapChatProviders } from './assistant/providers/bootstrap.js';
import { registerAssistantWeekly, unregisterAssistantWeekly } from './assistant/weekly/register.js';
import { assistantWeeklyRoutes } from './assistant/weekly/routes.js';
import { devForceVerifyRoutes } from './auth/dev-force-verify.js';
import { loginRoutes } from './auth/login.js';
import { logoutRoutes } from './auth/logout.js';
import { meRoutes } from './auth/me.js';
import { oauthRoutes } from './auth/oauth/routes.js';
import { preferenceRoutes } from './auth/preferences.js';
import { reauthRoutes } from './auth/reauth.js';
import { refreshRoutes } from './auth/refresh.js';
import { authRoutes } from './auth/register.js';
import { verifyRoutes } from './auth/verify.js';
import { chatLogRoutes } from './chat-logs/routes.js';
import { commentRoutes } from './comments/routes.js';
import { env } from './config/env.js';
import { closeDb, db } from './db/client.js';
import { MEMORY_EMBEDDING_DIM } from './db/schema.js';
import { deviceLoginRoutes } from './devices/login-routes.js';
import { registerMasterReaper } from './devices/master-reaper.js';
import { deviceMcpServerRoutes } from './devices/mcp-servers-routes.js';
import { devicePoolRoutes } from './devices/pool-routes.js';
import { registerDevicePrune } from './devices/prune.js';
import {
  deviceAuthRoutes,
  deviceOwnerRoutes,
  devicePublicRoutes,
  deviceUserRoutes,
} from './devices/routes.js';
import { runLedgerRoutes } from './devices/run-ledger-routes.js';
import { registerRunSessionReaper } from './devices/run-session-reaper.js';
import { deviceSkillRoutes, deviceSkillStatusRoutes } from './devices/skills-routes.js';
import { registerDeviceStaleDetector } from './devices/stale-detector.js';
import { domainTemplateRoutes } from './domain-templates/routes.js';
import { seedDomainTemplates } from './domain-templates/seed.js';
import { registerEagerSubscribers } from './eager-subscribers.js';
import { feedbackReportRoutes } from './feedback/routes.js';
import { guideRoutes } from './guides/routes.js';
import { opsHealthMeRoutes, opsHealthProjectRoutes, publicHealthRoutes } from './health/routes.js';
import { improvementMessageRoutes } from './improvement-messages/routes.js';
import { registerRunnerReleaseRefetch } from './install/fetch-release.js';
import { installRoutes } from './install/routes.js';
import { githubCallbackRoutes, githubConnectRoutes } from './integrations/github/connect-routes.js';
import { runnerReleaseRoutes } from './integrations/github/runner-release-routes.js';
import { registerIntegrationsHealthSweep } from './integrations/health-sweep.js';
import { integrationTargetRoutes } from './integrations/postman/target-routes.js';
import { registerIntegrationsWorker } from './integrations/queue.js';
import { registerAllIntegrations } from './integrations/register-all.js';
import { registerCommentMirror } from './integrations/rocketchat/comment-mirror.js';
import {
  startRocketChatManager,
  stopRocketChatManager,
} from './integrations/rocketchat/connection-manager.js';
import { integrationConnectionsRoutes, integrationsRoutes } from './integrations/routes.js';
import { assertVaultBootSafety } from './integrations/vault.js';
import { issueActivityRoutes, projectActivityRoutes } from './issues/activity-routes.js';
import { issueArchiveRoutes } from './issues/archive-routes.js';
import { attachmentRoutes, issueAttachmentRoutes } from './issues/attachment-routes.js';
import { backlogStreamRoutes, closeBacklogStreams } from './issues/backlog/routes.js';
import { issueDependencyRoutes } from './issues/dependency-routes.js';
import { issueExtrasRoutes } from './issues/extras-routes.js';
import { issueMergeRoutes } from './issues/merge-routes.js';
import { bodyRoutes, issueProjectRoutes, issueRoutes } from './issues/routes.js';
import { searchRoutes } from './issues/search.js';
import { issueSteerRoutes } from './issues/steer-routes.js';
import { transitionRoutes } from './issues/transition.js';
import { jobEventsListRoutes, jobEventsRoutes } from './jobs/events-routes.js';
import { jobLifecycleDeviceRoutes, jobLifecycleUserRoutes } from './jobs/lifecycle-routes.js';
import { registerPgBossHealthProbe } from './jobs/pgboss-health.js';
import { jobProjectRoutes, jobRoutes } from './jobs/routes.js';
import { registerStaleDetector } from './jobs/stale-detector.js';
import { knowledgeIngestRoutes } from './knowledge/ingest-routes.js';
import { knowledgeRoutes } from './knowledge/routes.js';
import { knowledgeEdgeRoutes } from './knowledge-edges/routes.js';
import { moduleDiagramRoutes } from './labels/module-diagram-routes.js';
import { labelProjectRoutes, labelRoutes } from './labels/routes.js';
import { isEnabled } from './lib/feature-flags.js';
import { logger } from './logger.js';
import { mcpHandler } from './mcp/handler.js';
import { mcpRequestClass } from './mcp/request-class.js';
import { meAttentionRoutes } from './me/attention-routes.js';
import { mePulseRoutes } from './me/pulse-routes.js';
import { meRecentChangesRoutes } from './me/recent-changes-routes.js';
import { registerChunkReindex } from './memory/chunk-reindex.js';
import {
  registerMemoryConsolidation,
  registerMemoryReconcileWorker,
} from './memory/consolidation.js';
import { registerMemoryDecay } from './memory/decay.js';
import { registerEmbeddingBackfill } from './memory/embedding-backfill.js';
import { memoryListRoutes } from './memory/list-routes.js';
import { memoryMineRoutes } from './memory/mine-routes.js';
import { memorySearchRoutes } from './memory/search-routes.js';
import { memoryWriteRoutes } from './memory/write-routes.js';
import { projectMetricsRoutes } from './metrics/routes.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { PAT_ACCEPTED_PERMISSIONS_HEADER } from './middleware/pat-rest-surface.js';
import { type RequestIdVars, requestId } from './middleware/request-id.js';
import { requirePat } from './middleware/require-pat.js';
import { notificationRoutes } from './notifications/routes.js';
import { orgInvitationRoutes } from './orgs/invitations-routes.js';
import { orgRoutes } from './orgs/routes.js';
import { sshKeyRoutes } from './orgs/ssh-keys-routes.js';
import { patRoutes } from './pat/routes.js';
import {
  pipelineAnalyticsRoutes,
  projectCostAnalyticsRoutes,
} from './pipeline/analytics-routes.js';
import { registerAnswerResume } from './pipeline/answer-resume.js';
import { hooks } from './pipeline/hooks.js';
import { registerPipelineOrchestrator } from './pipeline/orchestrator.js';
import { registerOutboxWorker, stopOutboxWorker } from './pipeline/outbox-worker.js';
import { registerPausedRunWedgeResolve } from './pipeline/paused-run-wedge-resolve.js';
import { registerPhaseJournalBackfill } from './pipeline/phase-journal-backfill.js';
import { registerPhaseJournalClose } from './pipeline/phase-journal-close.js';
import { phaseRoutes } from './pipeline/phase-routes.js';
import { registerReconciler } from './pipeline/reconciler.js';
import { pipelineRegistryRoutes } from './pipeline/registry-routes.js';
import { registerRetentionSweeper } from './pipeline/retention/sweep.js';
import { pipelineRunProjectRoutes, pipelineRunReadRoutes } from './pipeline/runs-read-routes.js';
import { pipelineRunRoutes } from './pipeline/runs-routes.js';
import { stepHandoffRoutes } from './pipeline/step-handoff-routes.js';
import { registerPipelineSweeper } from './pipeline/sweeper.js';
import { registerPmCadenceTicker, unregisterPmCadenceTicker } from './pm/cadence.js';
import {
  registerPmEscalationSweeper,
  unregisterPmEscalationSweeper,
} from './pm/escalation-sweeper.js';
import { registerPmQueuePressureSweeper } from './pm/queue-pressure.js';
import { pmReadRoutes } from './pm/read-routes.js';
import { pmRoutes } from './pm/routes.js';
import { collaboratorsMeRoutes } from './projects/collaborators-routes.js';
import { gitCredentialRoutes } from './projects/git-credential-routes.js';
import { projectHealthRoutes } from './projects/health-routes.js';
import { invitationRoutes } from './projects/invitations-routes.js';
import { memberRoutes } from './projects/members-routes.js';
import { projectRoutes } from './projects/routes.js';
import { promptRoutes } from './prompt/routes.js';
import { questionRoutes } from './questions/routes.js';
import { startBoss, stopBoss } from './queue/boss.js';
import { releaseBatchRoutes } from './release-batch/routes.js';
import { registerReleaseUnstartedRecovery } from './release-batch/unstarted-recovery.js';
import { bootstrapRunnerAdapters } from './runners/bootstrap.js';
import { registerGhostRunnerReaper } from './runners/ghost-reaper.js';
import { runnerRoutes } from './runners/routes.js';
import { registerRunnerStaleDetector } from './runners/stale-detector.js';
import { scheduleRoutes } from './schedules/routes.js';
import { registerScheduleTicker, unregisterScheduleTicker } from './schedules/runner.js';
import { skillFactsRoutes } from './skill-facts/routes.js';
import { skillActivityRoutes } from './skills/activity-routes.js';
import { seedBuiltinSkills } from './skills/builtin-seed.js';
import { skillCrudRoutes } from './skills/crud-routes.js';
import { divergenceCharterRoutes } from './skills/divergence-charter-routes.js';
import { skillPinRoutes } from './skills/pin-routes.js';
import { sweepPolicyLanded } from './skills/policy-landed.js';
import { reconcileRoutes } from './skills/reconcile-routes.js';
import { skillRegisterRoutes, skillSyncRoutes } from './skills/routes.js';
import { skillSmokeVerifyRoutes } from './skills/smoke-verify-routes.js';
import { skillStudioRoutes } from './skills/studio-routes.js';
import { taskIssueRoutes, taskRoutes } from './tasks/routes.js';
import { updatePacketRoutes } from './update-packets/routes.js';
import { uploadRoutes } from './uploads/routes.js';
import { usageRecordRoutes } from './usage-records/routes.js';
import { webhookInboundRoutes } from './webhooks/inbound-routes.js';
import { registerOutboundDeliveryWorker } from './webhooks/outbound.js';
import { registerWebhookSubscribers } from './webhooks/subscribers.js';
import { attachWs, closeWs } from './ws/server.js';

export const app = new Hono<{ Variables: RequestIdVars }>();

app.use('*', requestId());
app.use('*', requestLogger());

let corsOrigins: string[] | undefined;
function allowedOrigins(): string[] {
  corsOrigins ??= env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return corsOrigins;
}
const corsMiddleware = cors({
  origin: (origin) => (allowedOrigins().includes(origin) ? origin : null),
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization', 'X-Device-Token', 'X-Forge-Project-Slug'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: [
    'X-Total-Count',
    'Retry-After',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-RateLimit-Scope',
    PAT_ACCEPTED_PERMISSIONS_HEADER,
  ],
});
app.use('/api/*', corsMiddleware);
app.use('/mcp', corsMiddleware);

for (const at of ['/', '/api']) app.route(at, publicHealthRoutes);

app.notFound(notFoundHandler);
app.onError(errorHandler);

const SHUTDOWN_TIMEOUT_MS = 30_000;

export async function runShutdown(
  signal: string,
  server: { close: (cb?: (err?: Error) => void) => void },
): Promise<number> {
  logger.info({ signal }, '@forge/core shutdown initiated');

  const httpClosed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  const sequence = (async () => {
    await closeWs();
    await closeBacklogStreams();
    await stopRocketChatManager();
    await unregisterScheduleTicker();
    await unregisterPmCadenceTicker();
    await unregisterAgentCronTicker();
    await unregisterPmEscalationSweeper();
    await unregisterAssistantWeekly();
    await stopOutboxWorker();
    await stopBoss();
    await httpClosed;
    await closeDb();
  })();

  const timeout = new Promise<'timeout'>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS);
    t.unref?.();
  });

  const outcome = await Promise.race([sequence.then(() => 'ok' as const), timeout]);
  if (outcome === 'timeout') {
    logger.error('@forge/core shutdown timed out after 30s, forcing exit');
    return 1;
  }
  return 0;
}

registerEagerSubscribers(hooks);

app.use('/mcp', mcpRequestClass(), requirePat());
app.on(['POST', 'GET', 'DELETE'], '/mcp', mcpHandler);

app.route('/', installRoutes);
app.route('/api', installRoutes);

app.route('/', guideRoutes);
app.route('/api', guideRoutes);

app.get('/pair', (c) => {
  const code = c.req.query('code');
  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  return c.redirect(code ? `${base}/pair?code=${encodeURIComponent(code)}` : `${base}/pair`, 302);
});

app.route('/api/auth', authRoutes);
app.route('/api/auth', loginRoutes);
app.route('/api/auth', refreshRoutes);
app.route('/api/auth', verifyRoutes);
app.route('/api/auth', devForceVerifyRoutes);
app.route('/api/auth', meRoutes);
app.route('/api/auth', preferenceRoutes);
app.route('/api/auth', logoutRoutes);
app.route('/api/auth', reauthRoutes);
app.route('/api', patRoutes);
app.route('/api/auth', oauthRoutes);
app.route('/api/projects', projectHealthRoutes);
app.route('/api/projects', opsHealthProjectRoutes);
app.route('/api/me', opsHealthMeRoutes);
app.route('/api/me', collaboratorsMeRoutes);
app.route('/api/projects', projectMetricsRoutes);
app.route('/api/projects', gitCredentialRoutes);
app.route('/api/projects', runLedgerRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/projects', assistantWeeklyRoutes);
app.route('/api/orgs', orgRoutes);
app.route('/api/orgs', sshKeyRoutes);
app.route('/api/org-invitations', orgInvitationRoutes);
app.route('/api/projects', integrationsRoutes);
app.route('/api/projects', githubConnectRoutes);
app.route('/api/projects', runnerReleaseRoutes);
app.route('/api', githubCallbackRoutes);
app.route('/api/projects', integrationTargetRoutes);
app.route('/api/integration-connections', integrationConnectionsRoutes);
app.route('/api/projects', memberRoutes);
app.route('/api/projects', divergenceCharterRoutes);
app.route('/api/projects', skillSyncRoutes);
app.route('/api/projects', skillRegisterRoutes);
app.route('/api/projects', skillStudioRoutes);
app.route('/api/projects', skillPinRoutes);
app.route('/api/projects', skillSmokeVerifyRoutes);
app.route('/api/projects', reconcileRoutes);
app.route('/api/invitations', invitationRoutes);
app.route('/api/projects', issueProjectRoutes);
app.route('/api/projects', searchRoutes);
app.route('/api/projects', issueArchiveRoutes);
app.route('/api/projects', backlogStreamRoutes);
app.route('/api/projects', labelProjectRoutes);
app.route('/api/projects', moduleDiagramRoutes);
app.route('/api/projects', projectActivityRoutes);
app.route('/api/projects', jobProjectRoutes);
app.route('/api/issues', issueAttachmentRoutes);
app.route('/api/issues', issueExtrasRoutes);
app.route('/api/issues', issueMergeRoutes);
app.route('/api/uploads', uploadRoutes);
app.route('/api/issues', issueRoutes);
app.route('/api/issues', transitionRoutes);
app.route('/api/issues', issueActivityRoutes);
app.route('/api/issues', issueDependencyRoutes);
app.route('/api/issues', issueSteerRoutes);
app.route('/api/issues', taskIssueRoutes);
app.route('/api/tasks', taskRoutes);
app.route('/api/body', bodyRoutes);
app.route('/api/comments', commentRoutes);
app.route('/api/attachments', attachmentRoutes);
app.route('/api/labels', labelRoutes);
app.route('/api/jobs', jobRoutes);
app.route('/api/jobs', jobEventsRoutes);
app.route('/api/jobs', jobEventsListRoutes);
app.route('/api/jobs', jobLifecycleDeviceRoutes);
app.route('/api/jobs', jobLifecycleUserRoutes);
app.route('/api/webhooks', webhookInboundRoutes);
app.route('/api/memory', memorySearchRoutes);
app.route('/api/memory', memoryMineRoutes);
app.route('/api/memory', memoryListRoutes);
app.route('/api/memory', memoryWriteRoutes);
app.route('/api/issue-step-contexts', stepHandoffRoutes);
app.route('/api/prompts', promptRoutes);
app.route('/api/skill-facts', skillFactsRoutes);
app.route('/api/skill-activity', skillActivityRoutes);
app.route('/api/update-packets', updatePacketRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/me', meAttentionRoutes);
app.route('/api/me', mePulseRoutes);
app.route('/api/questions', questionRoutes);
app.route('/api', speakerLinkProjectRoutes);
app.route('/api', speakerLinkMeRoutes);
app.route('/api/me', meRecentChangesRoutes);
app.route('/api/agents', agentRoutes);
app.route('/api/conversations', conversationRoutes);
app.route('/api/agent-sessions', agentSessionAttachmentRoutes);
app.route('/api/agent-sessions', agentSessionRoutes);
app.route('/api/pipeline-runs', phaseRoutes);
app.route('/api/pipeline-runs', pipelineRunReadRoutes);
app.route('/api/pipeline-runs', pipelineRunRoutes);
app.route('/api/projects', pipelineRunProjectRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/admin', adminAggregateRoutes);
app.route('/api/admin', adminAlertRoutes);
app.route('/api/admin', adminMcpAuditRoutes);
app.route('/api/admin', adminMetricSeriesRoutes);
app.route('/api/admin', adminThresholdRoutes);
app.route('/api/admin/pipeline', pipelineHealthAdminRoutes);
app.route('/api/devices', devicePublicRoutes);
app.route('/api/devices', deviceLoginRoutes);
app.route('/api/devices', deviceAuthRoutes);
app.route('/api/devices', deviceSkillRoutes);
app.route('/api/devices', deviceMcpServerRoutes);
app.route('/api/devices', devicePoolRoutes);
app.route('/api', deviceOwnerRoutes);
app.route('/api/projects', deviceUserRoutes);
app.route('/api/projects', deviceSkillStatusRoutes);
app.route('/api/pipeline/registry', pipelineRegistryRoutes);
app.route('/api/pipeline', pipelineAnalyticsRoutes);
app.route('/api/projects', releaseBatchRoutes);
app.route('/api/projects', projectCostAnalyticsRoutes);
app.route('/api/schedules', scheduleRoutes);
app.route('/api/feedback-reports', feedbackReportRoutes);
app.route('/api/improvement-messages', improvementMessageRoutes);
app.route('/api/knowledge', knowledgeIngestRoutes);
app.route('/api/projects', knowledgeRoutes);
app.route('/api/knowledge-edges', knowledgeEdgeRoutes);
app.route('/api/skills', skillCrudRoutes);
app.route('/api/usage-records', usageRecordRoutes);
app.route('/api/chat-logs', chatLogRoutes);
app.route('/api/app-config', memoryModelRoutes);
app.route('/api/app-config', appConfigRoutes);
app.route('/api/domain-templates', domainTemplateRoutes);
app.route('/api/runners', runnerRoutes);

if (isEnabled('pmAgent')) {
  app.route('/api/projects', pmRoutes);
}
app.route('/api/projects', pmReadRoutes);
app.route('/api/projects', agentSessionProjectReadRoutes);

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const port = env.PORT;

  if (env.EMBEDDINGS_DIM !== MEMORY_EMBEDDING_DIM) {
    throw new Error(
      `EMBEDDINGS_DIM=${env.EMBEDDINGS_DIM} does not match the memories.embedding column dimension (${MEMORY_EMBEDDING_DIM}). Changing the embedding dimension requires a migration that rebuilds the column and re-embeds all rows.`,
    );
  }

  await startBoss();
  await assertVaultBootSafety();
  registerAllIntegrations();
  await registerIntegrationsWorker();
  const skillSeed = await seedBuiltinSkills(db);
  for (const change of skillSeed.changes) {
    await hooks.emit('globalSkillUpdated', {
      name: change.name,
      oldVersion: change.oldVersion,
      newVersion: change.newVersion,
      contentHash: change.contentHash,
    });
  }
  await sweepPolicyLanded();
  await seedDomainTemplates(db);
  bootstrapChatProviders();
  registerWebConversationAdapter();
  bootstrapRunnerAdapters();
  await registerStaleDetector();
  await registerIntegrationsHealthSweep();
  await registerDeviceStaleDetector();
  await registerEmbeddingBackfill();
  await registerChunkReindex();
  await registerMemoryDecay();
  await registerMemoryConsolidation();
  await registerAssistantWeekly();
  await registerMemoryReconcileWorker();
  await registerDevicePrune();
  await registerMasterReaper();
  await registerRunSessionReaper();
  await registerRunnerStaleDetector();
  await registerGhostRunnerReaper();
  await registerRetentionSweeper();
  await registerPipelineSweeper();
  await registerReleaseUnstartedRecovery();
  await registerPhaseJournalBackfill();
  await registerPgBossHealthProbe();
  await registerOutboundDeliveryWorker();
  await registerScheduleTicker();
  await registerPmCadenceTicker();
  await registerAgentCronTicker();
  await registerPmQueuePressureSweeper();
  await registerTranscriptIndexSweeper();
  await registerPmEscalationSweeper();
  registerWebhookSubscribers(hooks);
  registerPipelineOrchestrator(hooks);
  registerAnswerResume(hooks);
  registerCommentMirror(hooks);
  registerPhaseJournalClose(hooks);
  registerPausedRunWedgeResolve(hooks);

  registerOutboxWorker();
  await registerReconciler();

  registerRunnerReleaseRefetch();

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, '@forge/core listening');
  });

  attachWs(server as unknown as HttpServer);

  void startRocketChatManager().catch((err) =>
    logger.error({ err }, 'rocketchat: manager start failed'),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const code = await runShutdown(signal, server);
    process.exit(code);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
