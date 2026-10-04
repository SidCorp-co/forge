// The composition root: run the start sequence, mount the route registry, serve, wind down.

import './observability/sentry-init.js';
import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerWebConversationAdapter } from './assistant/index.js';
import { runOnceBackfills } from './boot-backfills.js';
import { env } from './config/env.js';
import { closeDb, db } from './db/client.js';
import { MEMORY_EMBEDDING_DIM } from './db/schema.js';
import { seedDomainTemplates } from './domain-templates/index.js';
import { registerEagerSubscribers } from './eager-subscribers.js';
import { registerContractMeasureWorker } from './ecosystem/index.js';
import { refreshMainRunnerHead, servesRunnerReleases } from './integrations/github/index.js';
import {
  assertVaultBootSafety,
  registerAllIntegrations,
  registerIntegrationsWorker,
} from './integrations/index.js';
import { bootstrapChatProviders } from './integrations/llm/index.js';
import { registerOutboundDeliveryWorker } from './integrations/outbound-webhooks/index.js';
import {
  registerCommentMirror,
  startRocketChatManager,
  stopRocketChatManager,
} from './integrations/rocketchat/index.js';
import { closeBacklogStreams } from './issues/index.js';
import { provideProjectOrg } from './lib/authz.js';
import { logger } from './logger.js';
import { registerChunkReindex, registerMemoryReconcileWorker } from './memory/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { PAT_ACCEPTED_PERMISSIONS_HEADER } from './middleware/pat-rest-surface.js';
import { type RequestIdVars, requestId } from './middleware/request-id.js';
import {
  hooks,
  registerAnswerResume,
  registerOutboxWorker,
  registerPausedRunWedgeResolve,
  registerPhaseJournalClose,
  registerPipelineOrchestrator,
  stopOutboxWorker,
} from './pipeline/index.js';
import { findProjectOrgId } from './projects/index.js';
import { startBoss, stopBoss } from './queue/boss.js';
import { registerReleaseBatchFinish } from './release-batch/index.js';
import { mountRoutes } from './route-registry.js';
import { bootstrapRunnerAdapters } from './runners/index.js';
import { startTimers, stopTimers } from './schedules/index.js';
import { seedBuiltinSkills, sweepPolicyLanded } from './skills/index.js';
import { coreTimers } from './timer-registry.js';
import { registerWebhookSubscribers } from './webhooks/index.js';
import { attachWs, closeWs } from './ws/index.js';

provideProjectOrg(findProjectOrgId);

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
    await stopTimers();
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

mountRoutes(app);

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
  await runOnceBackfills();
  await sweepPolicyLanded();
  await seedDomainTemplates(db);
  bootstrapChatProviders();
  registerWebConversationAdapter();
  bootstrapRunnerAdapters();
  await registerChunkReindex();
  await registerMemoryReconcileWorker();
  await registerContractMeasureWorker();
  await registerReleaseBatchFinish();
  await registerOutboundDeliveryWorker();
  registerWebhookSubscribers(hooks);
  registerPipelineOrchestrator(hooks);
  registerAnswerResume(hooks);
  registerCommentMirror(hooks);
  registerPhaseJournalClose(hooks);
  registerPausedRunWedgeResolve(hooks);
  registerOutboxWorker();

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, '@forge/core listening');
  });

  attachWs(server as unknown as HttpServer);

  void startRocketChatManager().catch((err) =>
    logger.error({ err }, 'rocketchat: manager start failed'),
  );

  await startTimers(coreTimers());
  if (servesRunnerReleases()) void refreshMainRunnerHead();

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
