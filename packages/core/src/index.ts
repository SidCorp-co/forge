// handoff-test ISS marker
import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
// Sentry init runs before any other module that might throw at import time —
// see observability/sentry.ts for the opt-in / scrubbing contract.
import { initSentry } from './observability/sentry.js';
initSentry();
import { pipelineHealthAdminRoutes } from './admin/pipeline-health-routes.js';
import { adminRoutes } from './admin/routes.js';
import { agentSessionAttachmentRoutes } from './agent-sessions/attachment-routes.js';
import { agentSessionRoutes } from './agent-sessions/routes.js';
import { registerAgentCronTicker, unregisterAgentCronTicker } from './agents/cron.js';
import { agentRoutes } from './agents/routes.js';
import { appConfigRoutes } from './app-config/routes.js';
import { pairingRoutes } from './auth/desktop/pairing-routes.js';
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
import { bootstrapChatProviders } from './chat/providers/bootstrap.js';
import { chatRoutes } from './chat/routes.js';
import { chatSessionRoutes } from './chat/sessions-routes.js';
import { commentRoutes } from './comments/routes.js';
import { commentUploadRoutes } from './comments/upload.js';
import { env } from './config/env.js';
import { closeDb, db } from './db/client.js';
import { MEMORY_EMBEDDING_DIM } from './db/schema.js';
import { deviceLoginRoutes } from './devices/login-routes.js';
import { registerDevicePrune } from './devices/prune.js';
import {
  deviceAuthRoutes,
  deviceOwnerRoutes,
  devicePublicRoutes,
  deviceUserRoutes,
} from './devices/routes.js';
import { deviceSkillRoutes, deviceSkillStatusRoutes } from './devices/skills-routes.js';
import { registerDeviceStaleDetector } from './devices/stale-detector.js';
import { domainTemplateRoutes } from './domain-templates/routes.js';
import { seedDomainTemplates } from './domain-templates/seed.js';
import { registerRunnerReleaseRefetch } from './install/fetch-release.js';
import { installRoutes } from './install/routes.js';
import { registerCoolifyAdapter } from './integrations/coolify/adapter.js';
import { registerEpodsystemAdapter } from './integrations/epodsystem/adapter.js';
import { registerIntegrationsHealthSweep } from './integrations/health-sweep.js';
import { registerPostmanAdapter } from './integrations/postman/adapter.js';
import { registerIntegrationsWorker } from './integrations/queue.js';
import { registerSentryAdapter } from './integrations/sentry/adapter.js';
import { integrationConnectionsRoutes, integrationsRoutes } from './integrations/routes.js';
import { assertVaultBootSafety } from './integrations/vault.js';
import { issueActivityRoutes, projectActivityRoutes } from './issues/activity-routes.js';
import { attachmentRoutes, issueAttachmentRoutes } from './issues/attachment-routes.js';
import { issueDependencyRoutes } from './issues/dependency-routes.js';
import { issueExtrasRoutes } from './issues/extras-routes.js';
import { issueProjectRoutes, issueRoutes } from './issues/routes.js';
import { searchRoutes } from './issues/search.js';
import { transitionRoutes } from './issues/transition.js';
import { registerDesktopPairingCleanup } from './jobs/desktop-pairing-cleanup.js';
import {
  registerDispatcher,
  registerPmDispatcher,
  unregisterDispatcher,
  unregisterPmDispatcher,
} from './jobs/dispatcher.js';
import { jobEventsListRoutes, jobEventsRoutes } from './jobs/events-routes.js';
import { jobLifecycleDeviceRoutes, jobLifecycleUserRoutes } from './jobs/lifecycle-routes.js';
import { registerPgBossHealthProbe } from './jobs/pgboss-health.js';
import { registerRetentionSweeper } from './jobs/retention-sweeper.js';
import { jobProjectRoutes, jobRoutes } from './jobs/routes.js';
import { registerStaleDetector } from './jobs/stale-detector.js';
import { knowledgeEdgeRoutes } from './knowledge-edges/routes.js';
import { knowledgeIngestRoutes } from './knowledge/ingest-routes.js';
import { labelProjectRoutes, labelRoutes } from './labels/routes.js';
import { isEnabled } from './lib/feature-flags.js';
import { logger } from './logger.js';
import { mcpHandler } from './mcp/handler.js';
import { meAttentionRoutes } from './me/attention-routes.js';
import { registerCandidatesDecay } from './memory/candidates-decay.js';
import {
  registerCandidatesObserver,
  registerCandidatesWorker,
} from './memory/candidates-observer.js';
import { memoryCandidatesRoutes } from './memory/candidates-routes.js';
import { registerMemoryConsolidation } from './memory/consolidation.js';
import { registerMemoryDecay } from './memory/decay.js';
import { registerEmbeddingBackfill } from './memory/embedding-backfill.js';
import { registerMemoryExtraction } from './memory/extraction.js';
import { registerMemoryIndexer } from './memory/indexer.js';
import { memoryListRoutes } from './memory/list-routes.js';
import { memorySearchRoutes } from './memory/search-routes.js';
import { memoryWriteRoutes } from './memory/write-routes.js';
import { projectMetricsRoutes } from './metrics/routes.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { type RequestIdVars, requestId } from './middleware/request-id.js';
import { requireDevice } from './middleware/require-device.js';
import { requirePatOrDevice } from './middleware/require-pat-or-device.js';
import { registerNotifyMentionsSubscriber } from './notifications/notify-mentions.js';
import { registerTransitionNotifications } from './notifications/notify-transitions.js';
import { notificationRoutes } from './notifications/routes.js';
import { orgInvitationRoutes } from './orgs/invitations-routes.js';
import { orgRoutes } from './orgs/routes.js';
import { patRoutes } from './pat/routes.js';
import {
  pipelineAnalyticsRoutes,
  projectCostAnalyticsRoutes,
} from './pipeline/analytics-routes.js';
import { registerCiFixPatternLearner } from './pipeline/ci-fix-pattern-learn.js';
import { registerDecompositionSubscribers } from './pipeline/decomposition-subscribers.js';
import { hooks } from './pipeline/hooks.js';
import { backfillMissingSkillPauses } from './pipeline/missing-skill-backfill.js';
import { registerMissingSkillResume } from './pipeline/missing-skill-resume.js';
import { registerPipelineOrchestrator } from './pipeline/orchestrator.js';
import { registerOutboxWorker } from './pipeline/outbox-worker.js';
import { registerReconciler } from './pipeline/reconciler.js';
import { pipelineRegistryRoutes } from './pipeline/registry-routes.js';
import { registerReleaseCompletedSubscriber } from './pipeline/release-coolify.js';
import { pipelineRunProjectRoutes, pipelineRunReadRoutes } from './pipeline/runs-read-routes.js';
import { pipelineRunRoutes } from './pipeline/runs-routes.js';
import { registerPipelineSentryBreadcrumbs } from './pipeline/sentry-breadcrumbs.js';
import { stepHandoffRoutes } from './pipeline/step-handoff-routes.js';
import { registerActivitySubscribers } from './pipeline/subscribers.js';
import { registerPipelineSweeper } from './pipeline/sweeper.js';
import { registerPmCadenceTicker, unregisterPmCadenceTicker } from './pm/cadence.js';
import {
  registerPmEscalationSweeper,
  unregisterPmEscalationSweeper,
} from './pm/escalation-sweeper.js';
import { registerPmQueuePressureSweeper } from './pm/queue-pressure.js';
import { pmRoutes } from './pm/routes.js';
import { registerPmSubscribers } from './pm/subscribers.js';
import { gitCredentialRoutes } from './projects/git-credential-routes.js';
import { projectHealthRoutes } from './projects/health-routes.js';
import { invitationRoutes } from './projects/invitations-routes.js';
import { memberRoutes } from './projects/members-routes.js';
import { projectRoutes } from './projects/routes.js';
import { promptRoutes } from './prompt/routes.js';
import { isBossStarted, startBoss, stopBoss } from './queue/boss.js';
import { bootstrapRunnerAdapters } from './runners/bootstrap.js';
import { runnerCallbackRoutes, runnerRoutes } from './runners/routes.js';
import { registerRunnerStaleDetector } from './runners/stale-detector.js';
import { improvementMessageRoutes } from './improvement-messages/routes.js';
import { scheduleRoutes } from './schedules/routes.js';
import { registerScheduleTicker, unregisterScheduleTicker } from './schedules/runner.js';
import { skillFactsRoutes } from './skill-facts/routes.js';
import { seedBuiltinSkills } from './skills/builtin-seed.js';
import { skillCrudRoutes } from './skills/crud-routes.js';
import { skillRegisterRoutes, skillSyncRoutes } from './skills/routes.js';
import { skillSmokeVerifyRoutes } from './skills/smoke-verify-routes.js';
import { skillStudioRoutes } from './skills/studio-routes.js';
import { taskIssueRoutes, taskRoutes } from './tasks/routes.js';
import { uploadRoutes } from './uploads/routes.js';
import { usageRecordRoutes } from './usage-records/routes.js';
import { webhookInboundRoutes } from './webhooks/inbound-routes.js';
import { registerOutboundDeliveryWorker } from './webhooks/outbound.js';
import { registerWebhookSubscribers } from './webhooks/subscribers.js';
import { registerWsBroadcastSubscribers } from './ws/broadcast-subscribers.js';
import { attachWs, closeWs, isWsListening } from './ws/server.js';

export const app = new Hono<{ Variables: RequestIdVars }>();

app.use('*', requestId());
app.use('*', requestLogger());

// Cookie-based auth from browsers requires Access-Control-Allow-Credentials
// with an explicit origin (never `*`). `CORS_ORIGINS` is a comma-separated
// allow-list; requests from unlisted origins receive no CORS headers.
//
// Tauri desktop client origins are added unconditionally — they're part of
// the product, not external embeds. Tauri 2 webview uses tauri://localhost
// on macOS/Linux and https://tauri.localhost on Windows. Without this,
// every fetch from the Tauri webview to /api/* fails CORS even though the
// app is "us" — operators would have to learn an undocumented env var.
const CORS_ORIGINS = [
  ...env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
  'tauri://localhost',
  'https://tauri.localhost',
];
// ISS-161 — /mcp is reachable from the browser (settings/mcp Test Connection
// panel) so the same CORS allow-list must cover it. `X-Forge-Project-Slug`
// is added to allowHeaders so the preflight passes for the per-project
// header the web UI sends alongside the bearer PAT.
const corsMiddleware = cors({
  origin: (origin) => (CORS_ORIGINS.includes(origin) ? origin : null),
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization', 'X-Device-Token', 'X-Forge-Project-Slug'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['X-Total-Count'],
});
app.use('/api/*', corsMiddleware);
app.use('/mcp', corsMiddleware);

app.get('/health', async (c) => {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const queueOk = isBossStarted();
  const wsOk = isWsListening();
  const allOk = dbOk && queueOk && wsOk;

  return c.json(
    {
      ok: allOk,
      db: { ok: dbOk },
      queue: { ok: queueOk },
      ws: { ok: wsOk },
    },
    allOk ? 200 : 503,
  );
});

app.notFound(notFoundHandler);
app.onError(errorHandler);

const SHUTDOWN_TIMEOUT_MS = 30_000;

export async function runShutdown(
  signal: string,
  server: { close: (cb?: (err?: Error) => void) => void },
): Promise<number> {
  logger.info({ signal }, '@forge/core shutdown initiated');

  // server.close() stops accepting new connections immediately and resolves
  // once all in-flight requests have finished.
  const httpClosed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  const sequence = (async () => {
    await closeWs();
    await unregisterDispatcher();
    await unregisterPmDispatcher();
    await unregisterScheduleTicker();
    await unregisterPmCadenceTicker();
    await unregisterAgentCronTicker();
    await unregisterPmEscalationSweeper();
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

registerActivitySubscribers(hooks);
registerPipelineSentryBreadcrumbs(hooks);
registerWsBroadcastSubscribers(hooks);
registerMemoryIndexer(hooks);
registerCiFixPatternLearner(hooks);
registerMemoryExtraction(hooks);
registerNotifyMentionsSubscriber(hooks);
registerTransitionNotifications(hooks);
registerPmSubscribers(hooks);
registerCandidatesObserver(hooks);

// MCP endpoint authentication (ISS-202 + ISS-150).
// Accepts either a device token (legacy desktop path) or a Personal Access
// Token (`forge_pat_*`) so non-device MCP clients (Cursor, Cline, Zed,
// web-only users) can authenticate with per-tenant scoping. The dispatcher
// middleware sets `c.get('principal')` to the resolved union type for the
// handler. Desktop continues to send `Authorization: Bearer <deviceToken>`
// with no client-side change.
app.use('/mcp', requirePatOrDevice());
app.post('/mcp', mcpHandler);
app.get('/mcp', mcpHandler);
app.delete('/mcp', mcpHandler);

// Public runner distribution: GET /install.sh, /install/latest.json, /install/bin/:target.
// Mounted at the root for self-hosters who expose core directly, AND under
// `/api` because the hosted edge proxy forwards only `/api/*` to core — the
// runner self-updater fetches `{core}/api/install/latest.json` (ISS-392). The
// route handlers echo the arriving prefix into the download URLs they emit.
app.route('/', installRoutes);
app.route('/api', installRoutes);

// The CLI runner's browser-approve login prints `{core_url}/pair?code=…`, but
// `core_url` is the API host (e.g. forge-beta-api.…) while the /pair page lives
// on the WEB origin (APP_BASE_URL). Existing runners build that URL from
// core_url and can't know the web host, so bounce them here — fixes every
// already-installed runner without cutting a runner release.
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
// ISS-158 — Fresh re-auth primitive for sensitive surfaces (PAT creation,
// device revoke, password change). Sibling children attach the
// requireFreshAuth() middleware at the gated routes.
app.route('/api/auth', reauthRoutes);
// ISS-150 — Personal Access Tokens (PAT) CRUD. User-scoped via JWT.
app.route('/api', patRoutes);
// ISS-314 — OAuth/OIDC (GitHub + Google + generic OIDC). Internally gated
// by `socialAuth` feature flag; safe to mount unconditionally.
app.route('/api/auth', oauthRoutes);
// ADR 0019 — Desktop sign-in via pairing code (Tauri client). Internally
// gated by `desktopPairing` feature flag; safe to mount unconditionally.
app.route('/api/auth', pairingRoutes);
// projectHealthRoutes mounts /health (static) and must register before
// projectRoutes which has GET /:id with a z.uuid() validator that would
// 400-reject the literal "health" segment.
app.route('/api/projects', projectHealthRoutes);
// ISS-380 — project time-series metrics. The deep `/:id/metrics/*` path does
// not collide with projectRoutes' `GET /:id`, but mount before it to mirror the
// health-routes precedent and keep the static-before-param ordering intent.
app.route('/api/projects', projectMetricsRoutes);
// Per-project git SSH deploy-key CRUD. Deep `/:projectId/git-credential` path
// does not collide with projectRoutes' `GET /:id`; mount before it to keep the
// static/deep-before-param ordering intent.
app.route('/api/projects', gitCredentialRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/orgs', orgRoutes);
app.route('/api/org-invitations', orgInvitationRoutes);
app.route('/api/projects', integrationsRoutes);
app.route('/api/integration-connections', integrationConnectionsRoutes);
app.route('/api/projects', memberRoutes);
app.route('/api/projects', skillSyncRoutes);
app.route('/api/projects', skillRegisterRoutes);
app.route('/api/projects', skillStudioRoutes);
app.route('/api/projects', skillSmokeVerifyRoutes);
app.route('/api/invitations', invitationRoutes);
app.route('/api/projects', issueProjectRoutes);
app.route('/api/projects', searchRoutes);
app.route('/api/projects', labelProjectRoutes);
app.route('/api/projects', projectActivityRoutes);
app.route('/api/projects', jobProjectRoutes);
// issueExtrasRoutes mounts /pipeline-timing (static) and must register before
// issueRoutes which has GET /:id with a z.uuid() validator that would
// 400-reject the literal "pipeline-timing" segment.
app.route('/api/issues', issueExtrasRoutes);
// issueAttachmentRoutes (POST/GET /:id/attachments) is mounted BEFORE issueRoutes
// so its requireAnyAuth() middleware handles attachment requests instead of
// issueRoutes' stricter requireAuth + assertEmailVerified. Both routers live
// under /api/issues but cover disjoint paths, so Hono routes correctly.
app.route('/api/issues', issueAttachmentRoutes);
// Capability-authenticated attachment upload (presigned-URL pattern). On its own
// /api/uploads prefix with NO auth middleware — the ticket id minted by
// forge_uploads is the bearer-free capability. Kept off /api/issues so it is not
// shadowed by issueRoutes' requireAuth (see require-any-auth shadowing note).
app.route('/api/uploads', uploadRoutes);
app.route('/api/issues', issueRoutes);
app.route('/api/issues', transitionRoutes);
app.route('/api/issues', issueActivityRoutes);
app.route('/api/issues', issueDependencyRoutes);
app.route('/api/issues', taskIssueRoutes);
app.route('/api/tasks', taskRoutes);
app.route('/api/comments', commentRoutes);
app.route('/api/comments', commentUploadRoutes);
app.route('/api/attachments', attachmentRoutes);
app.route('/api/labels', labelRoutes);
app.route('/api/jobs', jobRoutes);
app.route('/api/jobs', jobEventsRoutes);
app.route('/api/jobs', jobEventsListRoutes);
app.route('/api/jobs', jobLifecycleDeviceRoutes);
app.route('/api/jobs', jobLifecycleUserRoutes);
app.route('/api/webhooks', webhookInboundRoutes);
app.route('/api/memory', memorySearchRoutes);
app.route('/api/memory', memoryListRoutes);
app.route('/api/memory', memoryWriteRoutes);
app.route('/api/memory', memoryCandidatesRoutes);
app.route('/api/issue-step-contexts', stepHandoffRoutes);
app.route('/api/prompts', promptRoutes);
app.route('/api/skill-facts', skillFactsRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/me', meAttentionRoutes);
app.route('/api/agents', agentRoutes);
app.route('/api/chat/sessions', chatSessionRoutes);
app.route('/api/agent-sessions', agentSessionAttachmentRoutes);
app.route('/api/agent-sessions', agentSessionRoutes);
app.route('/api/pipeline-runs', pipelineRunReadRoutes);
app.route('/api/pipeline-runs', pipelineRunRoutes);
app.route('/api/projects', pipelineRunProjectRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/admin/pipeline', pipelineHealthAdminRoutes);
app.route('/api/devices', devicePublicRoutes);
app.route('/api/devices', deviceLoginRoutes);
app.route('/api/devices', deviceAuthRoutes);
app.route('/api/devices', deviceSkillRoutes);
app.route('/api', deviceOwnerRoutes);
app.route('/api/projects', deviceUserRoutes);
app.route('/api/projects', deviceSkillStatusRoutes);
app.route('/api/pipeline/registry', pipelineRegistryRoutes);
app.route('/api/pipeline', pipelineAnalyticsRoutes);
app.route('/api/projects', projectCostAnalyticsRoutes);
app.route('/api/schedules', scheduleRoutes);
app.route('/api/improvement-messages', improvementMessageRoutes);
app.route('/api/knowledge', knowledgeIngestRoutes);
app.route('/api/knowledge-edges', knowledgeEdgeRoutes);
app.route('/api/skills', skillCrudRoutes);
app.route('/api/usage-records', usageRecordRoutes);
app.route('/api/chat-logs', chatLogRoutes);
app.route('/api/app-config', appConfigRoutes);
app.route('/api/domain-templates', domainTemplateRoutes);
app.route('/api/runners', runnerRoutes);
app.route('/api/runners', runnerCallbackRoutes);

// v1 EPIC 1 (ISS-270) — chat support agent. Mount only when the flag is on
// so a default `main` build behaves as if the route doesn't exist.
if (isEnabled('chatProvider')) {
  app.route('/api/chat', chatRoutes);
}

// ISS-22 (PM Agent Epic 6) — config / policies / decisions CRUD + escalation
// respond endpoint. Mounted under /api/projects/:projectId/pm/*.
if (isEnabled('pmAgent')) {
  app.route('/api/projects', pmRoutes);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const port = env.PORT;

  // memory-v2 phase 0 — the memories.embedding column is vector(1536); a
  // mismatched EMBEDDINGS_DIM would pass client-side validation and then fail
  // (or silently corrupt) at insert time. Crash loudly at boot instead.
  if (env.EMBEDDINGS_DIM !== MEMORY_EMBEDDING_DIM) {
    throw new Error(
      `EMBEDDINGS_DIM=${env.EMBEDDINGS_DIM} does not match the memories.embedding column dimension (${MEMORY_EMBEDDING_DIM}). Changing the embedding dimension requires a migration that rebuilds the column and re-embeds all rows.`,
    );
  }

  await startBoss();
  await assertVaultBootSafety();
  registerCoolifyAdapter();
  registerPostmanAdapter();
  registerEpodsystemAdapter();
  registerSentryAdapter();
  await registerIntegrationsWorker();
  registerReleaseCompletedSubscriber(hooks);
  const skillSeed = await seedBuiltinSkills(db);
  for (const change of skillSeed.changes) {
    await hooks.emit('globalSkillUpdated', {
      name: change.name,
      oldVersion: change.oldVersion,
      newVersion: change.newVersion,
      contentHash: change.contentHash,
    });
  }
  await seedDomainTemplates(db);
  if (isEnabled('chatProvider')) {
    bootstrapChatProviders();
  }
  bootstrapRunnerAdapters();
  await registerDispatcher();
  await registerPmDispatcher();
  await registerStaleDetector();
  await registerIntegrationsHealthSweep();
  await registerDeviceStaleDetector();
  await registerEmbeddingBackfill();
  await registerMemoryDecay();
  await registerMemoryConsolidation();
  await registerCandidatesWorker();
  await registerCandidatesDecay();
  await registerDevicePrune();
  await registerRunnerStaleDetector();
  await registerRetentionSweeper();
  await registerDesktopPairingCleanup();
  await registerPipelineSweeper();
  await registerPgBossHealthProbe();
  await registerOutboundDeliveryWorker();
  await registerScheduleTicker();
  await registerPmCadenceTicker();
  await registerAgentCronTicker();
  await registerPmQueuePressureSweeper();
  await registerPmEscalationSweeper();
  registerWebhookSubscribers(hooks);
  registerPipelineOrchestrator(hooks);
  registerDecompositionSubscribers(hooks);
  // ISS-238 — resume paused runs whose missing skill was just registered.
  // Subscriber must register AFTER registerPipelineOrchestrator so the
  // re-enqueue path it triggers walks through the orchestrator's hooks.
  registerMissingSkillResume(hooks);

  // ISS-238 — opt-in backfill for projects that already have stuck runs
  // looping the reconciler rescue path. Runs once at boot; safe to re-run
  // (the underlying pause helper is idempotent via WHERE status='running').
  if (process.env.FORGE_BACKFILL_MISSING_SKILL_PAUSES === '1') {
    try {
      const result = await backfillMissingSkillPauses();
      logger.info(result, '@forge/core: missing-skill backfill complete');
    } catch (err) {
      logger.error({ err }, '@forge/core: missing-skill backfill failed');
    }
  }

  // ISS-196 — must run AFTER subscribers are wired so the worker's first
  // drain hits a populated bus. Outbox worker polls the transactional
  // outbox table; reconciler is the minute-cadence safety net.
  registerOutboxWorker();
  await registerReconciler();

  // ISS-392 — periodically re-ingest the latest `runner-v*` GitHub Release so a
  // freshly cut runner build is served (and auto-pulled by runners) without a
  // manual core redeploy. No-op when RUNNER_RELEASE_DIR is unset.
  registerRunnerReleaseRefetch();

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, '@forge/core listening');
  });

  // serve() is typed as a union that includes http2 variants, but we use the
  // default HTTP/1 server. Narrow for ws's WebSocketServer which only accepts
  // http/https servers.
  attachWs(server as unknown as HttpServer);

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
