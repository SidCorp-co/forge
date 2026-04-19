import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Server => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  app: {
    keys: env.array('APP_KEYS'),
  },
  cron: {
    enabled: true,
    tasks: {
      // Ingest CLI usage from ~/.claude every 10 minutes
      '*/10 * * * *': async ({ strapi }: { strapi: Core.Strapi }) => {
        try {
          const { ingestCliUsage } = await import('../src/services/cli-ingestion');
          const result = await ingestCliUsage(strapi);
          if (result.ingested > 0) {
            strapi.log.info(`CLI ingestion: ${result.ingested} new sessions from ${result.scanned} files`);
          }
        } catch (err) {
          strapi.log.error(`CLI ingestion cron error: ${err}`);
        }
      },
      // MCP knowledge sync — re-sync every 6 hours for projects with MCP servers
      '0 */6 * * *': async ({ strapi }: { strapi: Core.Strapi }) => {
        try {
          const { syncMcpKnowledge } = await import('../src/services/agent/mcp-sync');
          const projects: any[] = await strapi.documents('api::project.project' as any).findMany({
            filters: { mcpServers: { $notNull: true } },
          });
          for (const project of projects) {
            if (!project.mcpServers || Object.keys(project.mcpServers).length === 0) continue;
            syncMcpKnowledge(strapi, project).catch(err =>
              strapi.log.warn(`[MCP Cron] Sync failed for ${project.documentId}: ${err}`)
            );
            import('../src/services/agent/memory-lifecycle').then(({ pruneStaleMemories, invalidateStaleEdges }) => {
              pruneStaleMemories(strapi, project.documentId).catch(err =>
                strapi.log.warn(`[Lifecycle] Prune failed for ${project.documentId}: ${err}`)
              );
              invalidateStaleEdges(strapi, project.documentId).catch(err =>
                strapi.log.warn(`[Lifecycle] Edge invalidation failed for ${project.documentId}: ${err}`)
              );
            }).catch(() => {});
          }
        } catch (err) {
          strapi.log.error(`MCP sync cron error: ${err}`);
        }
      },
      // PO Agent scheduled reviews — check daily at 9 AM UTC
      '0 9 * * *': async ({ strapi }: { strapi: Core.Strapi }) => {
        try {
          const { triggerScheduledPoReviews } = await import('../src/services/po-agent-cron');
          await triggerScheduledPoReviews(strapi);
        } catch (err) {
          strapi.log.error(`PO Agent cron error: ${err}`);
        }
      },
      // Cleanup empty completed AG sessions — every hour
      '15 * * * *': async ({ strapi }: { strapi: Core.Strapi }) => {
        try {
          const { cleanupEmptyCompletedSessions } = await import('../src/services/session-cleanup');
          const deleted = await cleanupEmptyCompletedSessions(strapi);
          if (deleted > 0) {
            strapi.log.info(`[session-cleanup] Deleted ${deleted} empty completed sessions`);
          }
        } catch (err) {
          strapi.log.error(`Session cleanup cron error: ${err}`);
        }
      },
      // Schedule executor + heartbeat — runs every minute
      '* * * * *': async ({ strapi }: { strapi: Core.Strapi }) => {
        try {
          const { executeScheduledJobs } = await import('../src/services/schedule-executor');
          await executeScheduledJobs(strapi);
        } catch (err) {
          strapi.log.error(`Schedule executor cron error: ${err}`);
        }
        try {
          const { tick } = await import('../src/services/heartbeat');
          await tick(strapi);
        } catch (err) {
          strapi.log.error(`Heartbeat cron error: ${err}`);
        }
      },
    },
  },
});

export default config;
