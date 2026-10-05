// The composition root: run the start sequence, mount the route registry, serve, wind down.

import './error-tracking-init.js';
import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  composeLayers,
  METHOD_LAYERS,
  provideChatTools,
  registerRoomBridges,
  registerRoomChat,
  registerWebConversationAdapter,
} from './assistant/index.js';
import { runOnceBackfills } from './boot-backfills.js';
import { commentsSince, recentCommentBodies } from './comments/index.js';
import { logUnprovenPatPeppers } from './credentials/pat.js';
import { closeDb, db } from './db/client.js';
import { MEMORY_EMBEDDING_DIM } from './db/schema.js';
import {
  contractHolding,
  contractProviderGate,
  contractVersionReads,
  interfaceContractsOf,
} from './ecosystem/index.js';
import { provideExecutionPorts } from './execution-ports.js';
import {
  embedFeedback,
  provideFeedbackDependents,
  requirementFeedbackAs,
} from './feedback/index.js';
import { provideAssistantMethod } from './guides/index.js';
import { registerAllIntegrations } from './integration-registry.js';
import { refreshMainRunnerHead, servesRunnerReleases } from './integrations/github/index.js';
import { assertVaultBootSafety, provideForgeReads } from './integrations/index.js';
import { bootstrapChatProviders } from './integrations/llm/index.js';
import { startRocketChatManager, stopRocketChatManager } from './integrations/rocketchat/index.js';
import {
  activeIssuePrefix,
  allRelationDigests,
  archivedIssueIdsSql,
  citedIssues,
  claimIssuePrefix,
  heldIssuePrefixes,
  issueDisplayIds,
  issueHead,
  loadIssueRelationsForIssues,
  releasedIssueOf,
  resolveIssueForHeadRef,
  statusChangesSince,
} from './issues/index.js';
import {
  jobTypeOf,
  recordSecretResolve,
  rememberHandedOut,
  resolvePipelineContext,
} from './jobs/index.js';
import { provideKnowledgePorts } from './knowledge/index.js';
import { provideProjectOrg } from './lib/authz.js';
import { provideContractVersionReads } from './lib/contract-versions.js';
import { provideDataPolicy } from './lib/data-egress.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { CHAT_READ_MODEL_TOOLS } from './mcp/index.js';
import {
  provideMemoryIssueReads,
  registerMemoryReconcileWorker,
  runMemorySearch,
} from './memory/index.js';
import { provideMessageReads } from './messaging/reads.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { PAT_ACCEPTED_PERMISSIONS_HEADER } from './middleware/pat-rest-surface.js';
import { type RequestIdVars, requestId } from './middleware/request-id.js';
import { deleteFeedbackMockups } from './mockups/index.js';
import { emitNotification } from './notifications/index.js';
import { declareOutboxQueues, startOutboxWorker, stopOutboxWorker } from './outbox/index.js';
import { registerOutboxConsumers } from './outbox-consumers.js';
import { readsTechnical } from './permissions/index.js';
import { pipelineRunProjectId } from './pipeline/index.js';
import {
  encryptPlaintextBindingSecrets,
  provideProjectConfigPorts,
  readDeclaredSource,
  readProjectDocument,
} from './project-config/index.js';
import {
  findProjectOrgId,
  listProjectHeads,
  projectDocumentNames,
  projectHead,
  provideProjectsPorts,
} from './projects/index.js';
import { startBoss, stopBoss } from './queue/boss.js';
import {
  provideReleaseBatchPorts,
  registerDeployWorker,
  registerReleaseBatchFinish,
} from './release-batch/index.js';
import {
  embedRequirementHead,
  provideInterfaceContracts,
  provideRequirementDependents,
} from './requirements/index.js';
import { mountRoutes } from './route-registry.js';
import { bootstrapRunnerAdapters, deviceProjectIds } from './runners/index.js';
import { startTimers, stopTimers } from './schedules/index.js';
import { seedBuiltinSkills, sweepPolicyLanded } from './skills/index.js';
import {
  proposeRequirementDuplicate,
  redactFeedbackSuggestions,
  staleOnTargetRevised,
} from './suggestions/index.js';
import { coreTimers } from './timer-registry.js';
import { provideWorkPorts } from './work-ports.js';
import { workflowDesign } from './workflows/index.js';
import { attachWs, closeWs } from './ws/index.js';

provideProjectOrg(findProjectOrgId);
provideWorkPorts();
provideExecutionPorts();
provideAssistantMethod(composeLayers(METHOD_LAYERS));
provideKnowledgePorts({
  searchMemory: runMemorySearch,
  reembedRequirement: embedRequirementHead,
  reembedFeedback: embedFeedback,
});
provideMemoryIssueReads({
  displayIds: (issueIds) => issueDisplayIds(issueIds),
  relationEdges: async (issueIds, projectId) => {
    const relations = await loadIssueRelationsForIssues(issueIds, projectId);
    return new Map([...relations].map(([id, r]) => [id, allRelationDigests(r)]));
  },
  head: issueHead,
  releasedIssue: releasedIssueOf,
  recentCommentBodies,
  commentsSince,
  statusChangesSince,
  jobType: jobTypeOf,
  archivedIssueIds: archivedIssueIdsSql,
});
provideProjectsPorts({
  claimIssuePrefix,
  notifyInvitee: async (notice) => {
    await emitNotification({ ...notice, type: 'invitation_received' });
  },
});
provideProjectConfigPorts({
  projectDocumentNames,
  jobOfCredential: resolvePipelineContext,
  recordSecretResolve,
  rememberHandedOut,
});
provideChatTools(CHAT_READ_MODEL_TOOLS);
provideDataPolicy(
  async (projectId) => (await readProjectDocument(projectId))?.document.sensitiveData,
);
provideMessageReads({
  activeIssuePrefix,
  heldIssuePrefixes,
  citedIssues,
  workflowDesign,
  contractHolding,
  readsTechnical,
});
provideForgeReads({
  declaredRepository: async (projectId) => (await readDeclaredSource(projectId)).repository,
  issueForHeadRef: (projectId, headRef) => resolveIssueForHeadRef({ projectId, headRef }),
  projectSlug: async (projectId) => (await projectHead(projectId))?.slug ?? null,
  projectsByIds: listProjectHeads,
  runProjectOf: pipelineRunProjectId,
  deviceProjects: deviceProjectIds,
});
provideInterfaceContracts(interfaceContractsOf);
provideContractVersionReads(contractVersionReads);
provideReleaseBatchPorts({ contractProviderGate });
provideRequirementDependents({
  feedbackOf: requirementFeedbackAs,
  revised: staleOnTargetRevised,
  proposeDuplicate: proposeRequirementDuplicate,
});
provideFeedbackDependents({
  redactSuggestions: redactFeedbackSuggestions,
  deleteMockups: deleteFeedbackMockups,
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
  const encryptedBindingSecrets = await encryptPlaintextBindingSecrets();
  if (encryptedBindingSecrets > 0) {
    logger.info({ encryptedBindingSecrets }, 'vault: plaintext inbound webhook secrets encrypted');
  }
  await logUnprovenPatPeppers();
  registerAllIntegrations();
  await registerDeployWorker();
  await seedBuiltinSkills(db);
  await runOnceBackfills();
  await sweepPolicyLanded();
  bootstrapChatProviders();
  registerWebConversationAdapter();
  registerRoomChat();
  registerRoomBridges();
  bootstrapRunnerAdapters();
  await registerMemoryReconcileWorker();
  await registerReleaseBatchFinish();
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
