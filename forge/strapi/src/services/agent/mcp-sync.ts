import { initMcpSession, listMcpTools, callMcpTool } from './mcp-client';
import { upsertEmbedding, sanitizeContent, removeByFilter } from '../embeddings';

function extractItemId(item: any): string {
  return String(item.id || item.project_id || item.task_id || item.comment_id || '');
}

function extractItemText(item: any): string {
  const title = item.title || item.name || item.project_name || '';
  const desc = item.description || item.content || item.body || '';
  const status = item.status?.name || item.status || '';
  const priority = item.priority?.name || item.priority || '';
  const assignee = item.assignee?.name || item.assignee || '';
  const tags = [status, priority, assignee].filter(Boolean).map(s => `[${s}]`).join(' ');
  const parts = [title, tags, desc].filter(Boolean);
  return parts.join(' — ') || JSON.stringify(item);
}

async function callAndParse(
  url: string, headers: Record<string, string>, sessionId: string,
  toolName: string, args: Record<string, unknown>,
): Promise<any[]> {
  const result = await callMcpTool(url, headers, sessionId, toolName, args);
  if (!result?.content) return [];

  const textContent = result.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');

  if (!textContent) return [];

  try {
    let items = JSON.parse(textContent);
    if (!Array.isArray(items)) {
      const firstArray = Object.values(items).find(v => Array.isArray(v));
      items = firstArray ? (firstArray as any[]) : [items];
    }
    return items;
  } catch {
    return [{ text: textContent }];
  }
}

async function embed(
  projectDocId: string, sourceType: string, sourceId: string,
  text: string, metadata: Record<string, any>, strapi: any,
): Promise<void> {
  try {
    await upsertEmbedding({
      project_id: projectDocId,
      source_type: sourceType,
      source_id: sourceId,
      text: sanitizeContent(text).slice(0, 4000),
      metadata,
    });
  } catch (err) {
    strapi.log.warn(`[MCP Sync] Embedding failed for ${sourceType}:${sourceId}: ${err}`);
  }
}

/**
 * Sync knowledge from MCP servers into Qdrant embeddings.
 *
 * Pipeline:
 * 1. First chat or webhook triggers sync
 * 2. Cron re-syncs every 6 hours
 * 3. Forge pulls all data via MCP — no Hub code changes needed
 *
 * Phases:
 * - list_projects → hub_project
 * - get_tasks per project (paginated) → hub_task
 * - get_comments per task → hub_comment
 * - get_members/statuses/priorities → hub_config
 */
export async function syncMcpKnowledge(strapi: any, project: any): Promise<void> {
  const mcpServers = project.mcpServers;
  if (!mcpServers || Object.keys(mcpServers).length === 0) return;

  strapi.log.info(`[MCP Sync] Starting knowledge sync for project ${project.documentId}`);

  for (const [serverKey, config] of Object.entries(mcpServers) as [string, any][]) {
    try {
      const headers: Record<string, string> = { ...(config.headers || {}) };
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

      const sessionId = await initMcpSession(config.url, headers);
      const tools = await listMcpTools(config.url, headers, sessionId);
      const toolNames = tools.map((t: any) => t.name);
      const hasTool = (name: string) => toolNames.includes(name);

      // Phase 1: List projects
      const projects: any[] = hasTool('list_projects')
        ? await callAndParse(config.url, headers, sessionId, 'list_projects', {})
        : [];

      for (const proj of projects) {
        const projId = extractItemId(proj);
        await embed(project.documentId, 'hub_project', `${serverKey}:project:${projId}`,
          extractItemText(proj), { serverKey, itemId: projId }, strapi);
      }
      strapi.log.info(`[MCP Sync] Synced ${projects.length} projects from ${serverKey}`);

      // Phase 2: Get tasks per project (paginated)
      if (hasTool('get_tasks')) {
        for (const proj of projects) {
          const projId = Number(extractItemId(proj));
          if (!projId) continue;

          let page = 1;
          let totalTasks = 0;
          const taskIds: number[] = [];

          while (page <= 20) { // safety cap
            const tasks = await callAndParse(config.url, headers, sessionId, 'get_tasks', {
              project_id: projId,
              page,
              per_page: 100,
            });

            if (tasks.length === 0) break;

            for (const task of tasks) {
              const taskId = extractItemId(task);
              if (taskId) taskIds.push(Number(taskId));
              await embed(project.documentId, 'hub_task', `${serverKey}:task:${taskId}`,
                extractItemText(task),
                { serverKey, itemId: taskId, projectId: projId },
                strapi);
            }

            totalTasks += tasks.length;
            if (tasks.length < 100) break; // last page
            page++;
          }

          strapi.log.info(`[MCP Sync] Synced ${totalTasks} tasks for project ${projId}`);

          // Phase 3: Get comments per task
          if (hasTool('get_comments') && taskIds.length > 0) {
            let totalComments = 0;

            for (const taskId of taskIds) {
              try {
                const comments = await callAndParse(config.url, headers, sessionId, 'get_comments', {
                  project_id: projId,
                  task_id: taskId,
                });

                for (const comment of comments) {
                  const commentId = extractItemId(comment);
                  await embed(project.documentId, 'hub_comment', `${serverKey}:comment:${commentId}`,
                    extractItemText(comment),
                    { serverKey, itemId: commentId, projectId: projId, taskId },
                    strapi);
                }
                totalComments += comments.length;
              } catch (err) {
                strapi.log.warn(`[MCP Sync] get_comments failed for task ${taskId}: ${err}`);
              }
            }

            strapi.log.info(`[MCP Sync] Synced ${totalComments} comments for project ${projId}`);
          }
        }
      }

      // Phase 4: Sync config data (members, statuses, priorities)
      const configTools = ['get_members', 'get_statuses', 'get_priorities', 'get_task_types'];
      for (const toolName of configTools) {
        if (!hasTool(toolName)) continue;
        for (const proj of projects) {
          const projId = Number(extractItemId(proj));
          if (!projId) continue;
          try {
            const items = await callAndParse(config.url, headers, sessionId, toolName, { project_id: projId });
            for (const item of items) {
              const itemId = extractItemId(item);
              await embed(project.documentId, 'hub_config', `${serverKey}:${toolName}:${itemId}`,
                extractItemText(item),
                { serverKey, toolName, itemId, projectId: projId },
                strapi);
            }
          } catch {
            // non-critical, skip
          }
        }
      }

      // Phase 5: Sync GraphQL schema — split by section for targeted RAG retrieval
      if (hasTool('graphql_schema')) {
        try {
          const schemaResult = await callMcpTool(config.url, headers, sessionId, 'graphql_schema', {});
          const rawSchema = schemaResult?.content
            ?.filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n') || '';

          if (rawSchema) {
            // Split schema into sections by ## headers for targeted RAG retrieval.
            // Each section gets its own embedding so "revenue" queries match the Campaigns section,
            // not a truncated summary. Preamble (lines before first ##) is included in every section.
            const lines = rawSchema.split('\n');
            const preambleLines: string[] = [];
            const sections: { name: string; text: string }[] = [];
            let currentName = '';
            let currentLines: string[] = [];

            for (const line of lines) {
              if (line.startsWith('## ')) {
                if (currentName && currentLines.length > 0) {
                  sections.push({ name: currentName, text: [...preambleLines, '', ...currentLines].join('\n').trim() });
                }
                currentName = line.replace('## ', '').trim();
                currentLines = [line];
              } else if (!currentName) {
                preambleLines.push(line);
              } else {
                currentLines.push(line);
              }
            }
            if (currentName && currentLines.length > 0) {
              sections.push({ name: currentName, text: [...preambleLines, '', ...currentLines].join('\n').trim() });
            }

            if (sections.length > 0) {
              // Embed each section separately — RAG retrieves the relevant domain
              for (const section of sections) {
                await embed(project.documentId, 'mcp_schema', `${serverKey}:schema:${section.name.toLowerCase().replace(/\s+/g, '_')}`,
                  section.text.slice(0, 4000), { serverKey, section: section.name }, strapi);
              }
              strapi.log.info(`[MCP Sync] Synced GraphQL schema from ${serverKey} (${sections.length} sections)`);
            } else {
              // No ## headers — embed the whole schema as one entry
              await embed(project.documentId, 'mcp_schema', `${serverKey}:schema`, rawSchema.slice(0, 4000), { serverKey }, strapi);
              strapi.log.info(`[MCP Sync] Synced GraphQL schema from ${serverKey} (single block)`);
            }
          }
        } catch (err) {
          strapi.log.warn(`[MCP Sync] graphql_schema sync failed for ${serverKey}: ${err}`);
        }
      }

      // Phase 6: Prune stale tool_pattern memories after schema resync.
      // Tool patterns reference specific GQL field names that may have changed.
      // They're cheap to rebuild — created automatically on every successful GQL call.
      if (hasTool('graphql_schema')) {
        try {
          await removeByFilter(project.documentId, 'memory', 'tool_pattern');
          strapi.log.info(`[MCP Sync] Pruned stale tool_patterns for ${serverKey} — will rebuild from new queries`);
        } catch (err) {
          strapi.log.warn(`[MCP Sync] tool_pattern prune failed: ${err}`);
        }
      }
    } catch (err) {
      strapi.log.warn(`[MCP Sync] Server ${serverKey} failed: ${err}`);
    }
  }

  // Mark sync timestamp
  await strapi.documents('api::project.project').update({
    documentId: project.documentId,
    data: { mcpLastSyncAt: new Date().toISOString() },
  });

  strapi.log.info(`[MCP Sync] Completed for project ${project.documentId}`);
}
