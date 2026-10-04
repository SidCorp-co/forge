// The composition root: run the start sequence, mount the route registry, serve, wind down.

import './observability/sentry-init.js';
import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readThresholds } from './admin-thresholds/index.js';
import {
  provideChatTools,
  registerRoomBridges,
  registerRoomChat,
  registerWebConversationAdapter,
} from './assistant/index.js';
import { runOnceBackfills } from './boot-backfills.js';
import { env } from './config/env.js';
import { closeDb, db } from './db/client.js';
import { MEMORY_EMBEDDING_DIM } from './db/schema.js';
import { stampGitCredentialRef } from './devices/index.js';
import { seedDomainTemplates } from './domain-templates/index.js';
import { registerContractMeasureWorker } from './ecosystem/index.js';
import { provideAdmissionThresholds } from './error-intake/index.js';
import { provideGitCredentialStamp } from './git/index.js';
import { registerAllIntegrations } from './integration-registry.js';
import { assertVaultBootSafety, provideForgeReads } from './integrations/index.js';
import { bootstrapChatProviders } from './integrations/llm/index.js';
import { registerOutboundDeliveryWorker } from './integrations/outbound-webhooks/index.js';
import {
  refreshMainRunnerHead,
  servesRunnerReleases,
} from './integrations/published-releases/index.js';
import { startRocketChatManager, stopRocketChatManager } from './integrations/rocketchat/index.js';
import { closeBacklogStreams, resolveIssueForHeadRef } from './issues/index.js';
import { provideProjectOrg } from './lib/authz.js';
import { CHAT_READ_MODEL_TOOLS } from './mcp/index.js';
import { registerChunkReindex, registerMemoryReconcileWorker } from './memory/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { PAT_ACCEPTED_PERMISSIONS_HEADER } from './middleware/pat-rest-surface.js';
import { type RequestIdVars, requestId } from './middleware/request-id.js';
import { logger } from './observability/logger.js';
import {
  declareOutboxQueues,
  emitEvents,
  startOutboxWorker,
  stopOutboxWorker,
} from './outbox/index.js';
import { registerOutboxConsumers } from './outbox-consumers.js';
import { readDeclaredSource } from './project-config/index.js';
import { findProjectOrgId } from './projects/index.js';
import { startBoss, stopBoss } from './queue/boss.js';
import { registerDeployWorker, registerReleaseBatchFinish } from './release-batch/index.js';
import { mountRoutes } from './route-registry.js';
import { bootstrapRunnerAdapters } from './runners/index.js';
import { startTimers, stopTimers } from './schedules/index.js';
import { seedBuiltinSkills, sweepPolicyLanded } from './skills/index.js';
import { coreTimers } from './timer-registry.js';
import { attachWs, closeWs } from './ws/index.js';

provideProjectOrg(findProjectOrgId);
provideChatTools(CHAT_READ_MODEL_TOOLS);
provideGitCredentialStamp(stampGitCredentialRef);
provideForgeReads({
  declaredRepository: async (projectId) => (await readDeclaredSource(projectId)).repository,
  issueForHeadRef: (projectId, headRef) => resolveIssueForHeadRef({ projectId, headRef }),
});
provideAdmissionThresholds(async () => {
  const policy = await readThresholds();
  return { minEventCount: policy.sentryMinEventCount, minUserCount: policy.sentryMinUserCount };
});

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
  await declareOutboxQueues();
  await assertVaultBootSafety();
  registerAllIntegrations();
  await registerDeployWorker();
  const skillSeed = await seedBuiltinSkills(db);
  await emitEvents(
    db,
    skillSeed.changes.map((change) => ({
      type: 'skill.globalUpdated' as const,
      payload: {
        name: change.name,
        oldVersion: change.oldVersion,
        newVersion: change.newVersion,
        contentHash: change.contentHash,
      },
    })),
  );
  await runOnceBackfills();
  await sweepPolicyLanded();
  await seedDomainTemplates(db);
  bootstrapChatProviders();
  registerWebConversationAdapter();
  registerRoomChat();
  registerRoomBridges();
  bootstrapRunnerAdapters();
  await registerChunkReindex();
  await registerMemoryReconcileWorker();
  await registerContractMeasureWorker();
  await registerReleaseBatchFinish();
  await registerOutboundDeliveryWorker();
  registerOutboxConsumers();
  await startOutboxWorker();

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
