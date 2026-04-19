import type { Core } from '@strapi/strapi';
import { initWebSocket } from './services/websocket';
import { seedApiPermissions } from './bootstrap/seeds/api-permissions';
import { seedAgentDefinitions } from './bootstrap/seeds/agent-definitions';
import { seedProjectOwnership } from './bootstrap/seeds/project-ownership';
import { seedDomainTemplates } from './bootstrap/seeds/domain-templates';
import { seedAgentComms } from './bootstrap/seeds/agent-comms';
import { mcpMiddleware } from './services/mcp-server';
import { subscribeIssueLifecycles } from './lifecycles/issue-lifecycle';
import { subscribeTaskLifecycles } from './lifecycles/task-lifecycle';
import { subscribeProjectLifecycles, backfillProjectAgents } from './lifecycles/project-lifecycle';
import { subscribeSkillLifecycles, backfillSkillHashes } from './lifecycles/skill-lifecycle';
import { subscribeCommentLifecycles } from './lifecycles/comment-lifecycle';
import { ensureQdrantCollection } from './services/embeddings/qdrant';
import { needsBM25Backfill, backfillBM25Vectors } from './services/embeddings/bm25-backfill';
import { backfillCommentActivities } from './bootstrap/migrations/backfill-comment-activities';
import { backfillInverseRelations } from './bootstrap/migrations/backfill-inverse-relations';
import { updatePoAgentPrompt } from './bootstrap/migrations/update-po-agent-prompt';
import { reindexEmbeddings } from './bootstrap/migrations/reindex-embeddings';
import { cleanupPipelineSpam } from './bootstrap/migrations/cleanup-pipeline-spam';
import { cleanupStaleSessions } from './services/pipeline-orchestrator';
import { startStaleSessionWatcher, loadPipelineControlState } from './services/pipeline-utils';
import { startQuotaPoller } from './services/antigravity-quota';
import { startHealthPoller, startProjectHealthPoller, bootstrapRunners } from './services/antigravity-runner-pool';
import { startDreamPoller } from './services/memory-dream';

export default {
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    initWebSocket(strapi);
    await ensureQdrantCollection();
    await seedApiPermissions(strapi);
    await seedAgentDefinitions(strapi);
    await seedProjectOwnership(strapi);
    await seedDomainTemplates(strapi);
    await seedAgentComms(strapi);

    // Mount MCP Streamable HTTP endpoint at /mcp
    strapi.server.use(mcpMiddleware(strapi));

    // Register lifecycle hooks
    subscribeIssueLifecycles(strapi);
    subscribeTaskLifecycles(strapi);
    subscribeProjectLifecycles(strapi);
    subscribeSkillLifecycles(strapi);
    subscribeCommentLifecycles(strapi);

    // Backfill agents for existing projects (reads definitions from DB)
    await backfillProjectAgents(strapi);

    // One-time migrations
    await backfillSkillHashes(strapi);
    await backfillCommentActivities(strapi);
    await cleanupPipelineSpam(strapi);
    await backfillInverseRelations(strapi);
    await updatePoAgentPrompt(strapi);

    // Re-embed all data if collection is empty (after collection recreation)
    reindexEmbeddings(strapi).catch((err) => strapi.log.warn(`[reindex] failed: ${err}`));

    // BM25 sparse vector backfill (fire-and-forget, non-blocking)
    needsBM25Backfill().then((needs) => {
      if (needs) backfillBM25Vectors().catch((err) => strapi.log.warn(`[bm25-backfill] failed: ${err}`));
    }).catch(() => {});

    // Load pipeline control state (paused/running) from DB
    await loadPipelineControlState(strapi);

    // Clean up pipeline sessions stuck as "running" from previous process
    await cleanupStaleSessions(strapi);

    // Watch for stale sessions every 2 min and promote queued jobs
    startStaleSessionWatcher(strapi);

    // Discover agents from proxy and register runner records
    await bootstrapRunners();

    // Poll Antigravity runner health every 60s
    startHealthPoller();

    // Poll Antigravity model quota every 15 min (gates pipeline dispatch)
    startQuotaPoller();

    // Poll errored projects every 5 min to restore antigravity connectivity
    startProjectHealthPoller();

    // Dream memory consolidation — checks hourly, runs every 24h
    startDreamPoller(strapi);

    // Heartbeat — initialize state (cron handles scheduling)
    const { startHeartbeat } = await import('./services/heartbeat');
    startHeartbeat(strapi);

    // Channel bootstrap — load from project.channels DB config
    const { bootstrapChannels } = require('./services/channels/bootstrap');
    bootstrapChannels(strapi).catch((err: any) => strapi.log.error(`Channel bootstrap failed: ${err}`));
  },
};
