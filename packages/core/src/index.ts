// The composition root: run the start sequence, mount the route registry, serve, wind down.

import './error-tracking-init.js';
import { createServer, type Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  admitChatRestWrite,
  agreedRecordsIn,
  composeLayers,
  holdChatRestWrite,
  METHOD_LAYERS,
  provideAgreementReplay,
  provideChatTools,
  provideHeldWriteVets,
  refuseChatToolWrite,
  registerRoomBridges,
  registerRoomChat,
  registerWebConversationAdapter,
} from './assistant/index.js';
import { agentAccountsAmong } from './auth/index.js';
import { runOnceBackfills, startDeferredBackfills } from './boot-backfills.js';
import { commentsSince, recentCommentBodies } from './comments/index.js';
import { logUnprovenPatPeppers } from './credentials/pat.js';
import { provideCredentialsPorts } from './credentials/ports.js';
import { closeDb, db } from './db/client.js';
import { MEMORY_EMBEDDING_DIM } from './db/schema.js';
import {
  contractHolding,
  contractProviderGate,
  contractVersionReads,
  interfaceContractsOf,
} from './ecosystem/index.js';
import { provideExecutionPorts } from './execution-ports.js';
import { provideFastLanePorts } from './fast-lane/index.js';
import {
  embedFeedback,
  provideFeedbackDependents,
  requirementFeedbackAs,
} from './feedback/index.js';
import { releaseLegFor } from './forecast/index.js';
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
  issueIdOfKey,
  issueStandingsBySeq,
  loadIssueRelationsForIssues,
  refuseUnresolvedIssueKey,
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
import { provideProjectOrg, provideVisibleProjects } from './lib/authz.js';
import { provideContractVersionReads } from './lib/contract-versions.js';
import { provideDataPolicy } from './lib/data-egress.js';
import { env } from './lib/env.js';
import { provideEphemeralPublisher } from './lib/ephemeral.js';
import { logger } from './lib/logger.js';
import { provideWrittenLangPorts } from './lib/written-lang.js';
import {
  CHAT_READ_MODEL_TOOLS,
  CHAT_RECORD_TOOLS,
  CHAT_RECORD_VETS,
  CHAT_REPORT_TOOLS,
} from './mcp/index.js';
import {
  provideMemoryIssueReads,
  registerMemoryReconcileWorker,
  runMemorySearch,
} from './memory/index.js';
import { provideMessageReads } from './messaging/reads.js';
import { provideChatWriteHold } from './middleware/chat-write-hold.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestLogger } from './middleware/logger.js';
import { PAT_ACCEPTED_PERMISSIONS_HEADER } from './middleware/pat-rest-surface.js';
import { readMemo } from './middleware/read-memo.js';
import { type RequestIdVars, requestId } from './middleware/request-id.js';
import {
  provideRouteRefSources,
  refuseUnresolvedRefs,
  resolvingRouteRefs,
  unaddressableProjectSlug,
} from './middleware/route-refs.js';
import { SERVER_TIMING_HEADER, serverTiming } from './middleware/server-timing.js';
import { deleteFeedbackMockups } from './mockups/index.js';
import { emitNotification } from './notifications/index.js';
import {
  declareOutboxQueues,
  emitEvent,
  startOutboxWorker,
  stopOutboxWorker,
} from './outbox/index.js';
import { registerOutboxConsumers } from './outbox-consumers.js';
import { providePermissionsPorts, readsTechnical } from './permissions/index.js';
import { pipelineRunProjectId } from './pipeline/index.js';
import { approvedPreviewOf, withPreviewHosts } from './previews/index.js';
import {
  encryptPlaintextBindingSecrets,
  provideProjectConfigPorts,
  readContentLanguage,
  readDeclaredSource,
  readProjectDocument,
  webUrlOf,
} from './project-config/index.js';
import { readProjectStatus, statusViewerOf } from './project-status/index.js';
import {
  findProjectIdBySlug,
  findProjectOrgId,
  findProjectOrgIds,
  findVisibleProjectIds,
  listProjectHeads,
  orgSiblingProjects,
  projectDocumentNames,
  projectHead,
  projectOrgIdSql,
  provideProjectsPorts,
} from './projects/index.js';
import { startBoss, stopBoss } from './queue/boss.js';
import {
  liveBuildHolds,
  provideReleaseBatchPorts,
  registerDeployWorker,
  registerReleaseBatchFinish,
  releaseVersionsAmong,
} from './release-batch/index.js';
import { providePreferencesPorts } from './preferences/index.js';
import { releaseShareSource } from './release-page/index.js';
import { provideReportPorts } from './report-ports.js';
import { registerReportQueries } from './report-queries/index.js';
import {
  checkTemplateNarrative,
  keptExecutionFrames,
  keptRunFrames,
  messageShareSource,
  runTemplate,
  templateShareSource,
} from './reports/index.js';
import {
  embedRequirementHead,
  provideInterfaceContracts,
  provideRequirementDependents,
  requirementStatusesBySeq,
} from './requirements/index.js';
import { mountRoutes } from './route-registry.js';
import { bootstrapRunnerAdapters, deviceProjectIds } from './runners/index.js';
import { provideSandboxPorts } from './sandbox/index.js';
import { startTimers, stopTimers } from './schedules/index.js';
import { provideShareSubjectSources } from './shares/index.js';
import { seedBuiltinSkills, sweepPolicyLanded } from './skills/index.js';
import { provideStatusReportsPorts, statusReportShareSource } from './status-reports/index.js';
import {
  proposeRequirementDuplicate,
  redactFeedbackSuggestions,
  staleOnTargetRevised,
} from './suggestions/index.js';
import { coreTimers } from './timer-registry.js';
import { provideWorkPorts } from './work-ports.js';
import { readServing } from './whats-new/index.js';
import { workflowDesign, workflowFlowsOf } from './workflows/index.js';
import { attachWs, closeWs, publishEphemeralFrame } from './ws/index.js';

provideProjectOrg(findProjectOrgId);
provideRouteRefSources({
  projectIdOfSlug: findProjectIdBySlug,
  issueIdOfKey,
  refuseIssueKey: refuseUnresolvedIssueKey,
});
provideVisibleProjects(findVisibleProjectIds);
provideEphemeralPublisher(publishEphemeralFrame);
provideCredentialsPorts({
  tokenChanged: (change) => emitEvent(db, 'credential.tokenChanged', change),
});
providePermissionsPorts({
  projectOrgIdSql,
  projectOrgIds: findProjectOrgIds,
  agentAccountsAmong,
});
provideWorkPorts();
provideExecutionPorts();
// the fast lane reads an issue's approved preview from the previews module (REQ-39 BC-7)
provideFastLanePorts({ approvedPreviewOf });
provideStatusReportsPorts({
  readProjectStatus: ({ projectId, access, userId, agency, days, now }) =>
    readProjectStatus(projectId, statusViewerOf(access, userId, agency), days, now),
  runTemplate: async (args) => {
    const { document, narrative, notDrawn } = await runTemplate({ ...args, surface: 'rest' });
    return { document, narrative, notDrawn };
  },
  checkTemplateNarrative,
});
// a message's blocks, a template's output and a kept template report: each is frozen by the module
// that owns it into one report document (REQ-32 A4, A7, B3); a release page is frozen as its user
// view (REQ-40 BC-11)
provideShareSubjectSources([
  messageShareSource,
  templateShareSource,
  statusReportShareSource,
  releaseShareSource,
]);
// the seen-mark rule asks which release this instance serves, which What's new reads (REQ-40 BC-10)
providePreferencesPorts({
  serving: async () => {
    const { environment, release } = await readServing();
    return { environment, version: release?.version ?? null };
  },
});
provideAssistantMethod(composeLayers(METHOD_LAYERS));
provideKnowledgePorts({
  searchMemory: runMemorySearch,
  reembedRequirement: embedRequirementHead,
  reembedFeedback: embedFeedback,
});
provideMemoryIssueReads({
  displayIds: issueDisplayIds,
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
  issuePrefixes: async (projectId) => ({
    active: await activeIssuePrefix(projectId),
    held: await heldIssuePrefixes(projectId),
  }),
  issueStandings: issueStandingsBySeq,
  requirementStatuses: requirementStatusesBySeq,
  workflowFlows: workflowFlowsOf,
  siblingProjects: orgSiblingProjects,
  repositoryWebUrl: async (projectId) => {
    const repository = (await readDeclaredSource(projectId)).repository;
    return repository ? webUrlOf(repository) : null;
  },
  releaseVersions: releaseVersionsAmong,
});
provideProjectsPorts({
  claimIssuePrefix,
  notifyInvitee: async (notice) => {
    await emitNotification({ ...notice, type: 'invitation_received' });
  },
  unaddressableSlug: unaddressableProjectSlug,
});
provideWrittenLangPorts({
  contentLanguageOf: async (projectId) => (await readContentLanguage(projectId)).contentLanguage,
});
provideProjectConfigPorts({
  projectDocumentNames,
  unaddressableSlug: unaddressableProjectSlug,
  jobOfCredential: resolvePipelineContext,
  recordSecretResolve,
  rememberHandedOut,
});
// the chat toolset composed below describes the registered queries, so they are registered first
registerReportQueries();
provideReportPorts();
provideChatTools([...CHAT_READ_MODEL_TOOLS, ...CHAT_RECORD_TOOLS, ...CHAT_REPORT_TOOLS]);
provideHeldWriteVets(CHAT_RECORD_VETS);
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
  // an execution's frames ground a figure as a run's do; the ids a turn names are read in both
  reportRunFrames: async (projectId, ids, tx) => [
    ...(await keptRunFrames(projectId, ids, tx)),
    ...(await keptExecutionFrames(projectId, ids, tx)),
  ],
  agreedRecords: agreedRecordsIn,
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
  releaseLeg: releaseLegFor,
  liveBuildHolds,
});
provideFeedbackDependents({
  redactSuggestions: redactFeedbackSuggestions,
  deleteMockups: deleteFeedbackMockups,
});

export const app = new Hono<{ Variables: RequestIdVars }>();

// a chat write to a record route waits for the person to agree, and the agreed write is replayed
// through this app as them (REQ-30 BC-4)
provideChatWriteHold({
  hold: holdChatRestWrite,
  admit: admitChatRestWrite,
  tool: refuseChatToolWrite,
});
provideAgreementReplay((request) => Promise.resolve(app.fetch(request)));
// a script's ctx.forge.get is answered by this app in-process, under its owner's read token (REQ-37)
provideSandboxPorts({ restFetch: (request) => Promise.resolve(app.fetch(request)) });

let corsOrigins: string[] | undefined;
function allowedOrigins(): string[] {
  corsOrigins ??= env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return corsOrigins;
}

app.use(
  '*',
  serverTiming((origin) => allowedOrigins().includes(origin)),
);
app.use('*', readMemo());
app.use('*', requestId());
app.use('*', requestLogger());
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
    SERVER_TIMING_HEADER,
  ],
});
app.use('/api/*', corsMiddleware);
app.use('/mcp', corsMiddleware);
app.use('/api/*', refuseUnresolvedRefs());

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
app.fetch = resolvingRouteRefs(app as unknown as Hono<never>, app.fetch);

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

  // a preview host (`<label>.<PREVIEW_DOMAIN>`) is answered by the preview relay before the API
  // routes, as raw Node requests it streams to the box (REQ-39)
  const server = serve(
    {
      fetch: app.fetch,
      port,
      createServer: ((options, listener) =>
        createServer(options, withPreviewHosts(listener))) as typeof createServer,
    },
    (info) => {
      logger.info({ port: info.port }, '@forge/core listening');
    },
  );

  attachWs(server as unknown as HttpServer);
  startDeferredBackfills();

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
