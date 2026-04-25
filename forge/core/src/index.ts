import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { adminRoutes } from './admin/routes.js';
import { loginRoutes } from './auth/login.js';
import { logoutRoutes } from './auth/logout.js';
import { meRoutes } from './auth/me.js';
import { refreshRoutes } from './auth/refresh.js';
import { authRoutes } from './auth/register.js';
import { devForceVerifyRoutes } from './auth/dev-force-verify.js';
import { verifyRoutes } from './auth/verify.js';
import { commentRoutes } from './comments/routes.js';
import { commentUploadRoutes } from './comments/upload.js';
import { env } from './config/env.js';
import { closeDb, db } from './db/client.js';
import { deviceAuthRoutes, devicePublicRoutes, deviceUserRoutes } from './devices/routes.js';
import { registerDeviceStaleDetector } from './devices/stale-detector.js';
import { issueActivityRoutes, projectActivityRoutes } from './issues/activity-routes.js';
import { issueProjectRoutes, issueRoutes } from './issues/routes.js';
import { searchRoutes } from './issues/search.js';
import { transitionRoutes } from './issues/transition.js';
import { registerDispatcher, unregisterDispatcher } from './jobs/dispatcher.js';
import { jobEventsListRoutes, jobEventsRoutes } from './jobs/events-routes.js';
import { jobLifecycleDeviceRoutes, jobLifecycleUserRoutes } from './jobs/lifecycle-routes.js';
import { registerRetentionSweeper } from './jobs/retention-sweeper.js';
import { jobProjectRoutes, jobRoutes } from './jobs/routes.js';
import { registerStaleDetector } from './jobs/stale-detector.js';
import { labelProjectRoutes, labelRoutes } from './labels/routes.js';
import { logger } from './logger.js';
import { mcpHandler } from './mcp/handler.js';
import { registerMemoryIndexer } from './memory/indexer.js';
import { memorySearchRoutes } from './memory/search-routes.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { type RequestIdVars, requestId } from './middleware/request-id.js';
import { requireDevice } from './middleware/require-device.js';
import { hooks } from './pipeline/hooks.js';
import { registerPipelineOrchestrator } from './pipeline/orchestrator.js';
import { registerActivitySubscribers } from './pipeline/subscribers.js';
import { invitationRoutes } from './projects/invitations-routes.js';
import { memberRoutes } from './projects/members-routes.js';
import { projectRoutes } from './projects/routes.js';
import { isBossStarted, startBoss, stopBoss } from './queue/boss.js';
import { seedBuiltinSkills } from './skills/builtin-seed.js';
import { skillRegisterRoutes, skillSyncRoutes } from './skills/routes.js';
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
const CORS_ORIGINS = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
app.use(
  '/api/*',
  cors({
    origin: (origin) => (CORS_ORIGINS.includes(origin) ? origin : null),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Device-Token'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['X-Total-Count'],
  }),
);

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
registerWsBroadcastSubscribers(hooks);
registerMemoryIndexer(hooks);

// MCP endpoint requires device authentication (ISS-202). Tool handlers
// close over the authenticated Device to enforce project-scope. This is a
// breaking change for MCP clients — forge/dev must send
// `Authorization: Bearer <deviceToken>` instead of `X-Forge-API-Key`.
app.use('/mcp', requireDevice());
app.post('/mcp', mcpHandler);
app.get('/mcp', mcpHandler);
app.delete('/mcp', mcpHandler);

app.route('/api/auth', authRoutes);
app.route('/api/auth', loginRoutes);
app.route('/api/auth', refreshRoutes);
app.route('/api/auth', verifyRoutes);
app.route('/api/auth', devForceVerifyRoutes);
app.route('/api/auth', meRoutes);
app.route('/api/auth', logoutRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/projects', memberRoutes);
app.route('/api/projects', skillSyncRoutes);
app.route('/api/projects', skillRegisterRoutes);
app.route('/api/invitations', invitationRoutes);
app.route('/api/projects', issueProjectRoutes);
app.route('/api/projects', searchRoutes);
app.route('/api/projects', labelProjectRoutes);
app.route('/api/projects', projectActivityRoutes);
app.route('/api/projects', jobProjectRoutes);
app.route('/api/issues', issueRoutes);
app.route('/api/issues', transitionRoutes);
app.route('/api/issues', issueActivityRoutes);
app.route('/api/comments', commentRoutes);
app.route('/api/comments', commentUploadRoutes);
app.route('/api/labels', labelRoutes);
app.route('/api/jobs', jobRoutes);
app.route('/api/jobs', jobEventsRoutes);
app.route('/api/jobs', jobEventsListRoutes);
app.route('/api/jobs', jobLifecycleDeviceRoutes);
app.route('/api/jobs', jobLifecycleUserRoutes);
app.route('/api/webhooks', webhookInboundRoutes);
app.route('/api/memory', memorySearchRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/devices', devicePublicRoutes);
app.route('/api/devices', deviceAuthRoutes);
app.route('/api/projects', deviceUserRoutes);

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const port = env.PORT;

  await startBoss();
  await seedBuiltinSkills(db);
  await registerDispatcher();
  await registerStaleDetector();
  await registerDeviceStaleDetector();
  await registerRetentionSweeper();
  await registerOutboundDeliveryWorker();
  registerWebhookSubscribers(hooks);
  registerPipelineOrchestrator(hooks);

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
