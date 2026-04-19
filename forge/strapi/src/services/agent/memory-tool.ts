import type { ForgeTool } from './tools';
import { listMemories, searchMemories, addMemory, removeMemory, exportMemoriesAsMarkdown, SKILL_MEMORY_ROLES, type MemoryRole, type MemoryVisibility } from './memory';
import { extractEntitiesAndEdges } from '../knowledge-graph/entity-extractor';

const VALID_ROLES: MemoryRole[] = ['ceo', 'cto', 'pm', 'po', 'techlead', 'dev', 'qa', 'devops'];
const VALID_VISIBILITIES: MemoryVisibility[] = ['down', 'same', 'up', 'all'];

/** Resolve a target project by slug. Returns the project documentId or null. */
async function resolveTargetProject(strapi: any, slug: string): Promise<string | null> {
  const project = await strapi.documents('api::project.project').findFirst({
    filters: { slug: { $eq: slug } },
    fields: ['documentId'],
  });
  return project?.documentId || null;
}

export const forgeMemory: ForgeTool = {
  name: 'forge_memory',
  description: 'Role-scoped memory with scope/visibility/role filters. Actions: list, add, remove, sync, search. Use search (hybrid strategy default) for retrieval. Use targetProjectSlug for cross-project access.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove', 'sync', 'search'] },
      targetProjectSlug: { type: 'string', description: 'Optional: access memories in a different project by slug (cross-project)' },
      category: { type: 'string', enum: ['preference', 'correction', 'convention'] },
      content: { type: 'string' },
      documentId: { type: 'string' },
      role: { type: 'string', enum: VALID_ROLES, description: 'Who wrote it (default: dev)' },
      visibility: { type: 'string', enum: VALID_VISIBILITIES, description: 'Who should see it: down/same/up/all (default: all)' },
      scope: { type: 'string', enum: ['user', 'project', 'global'], description: 'Scope: user, project, or global (cross-project)' },
      skill: { type: 'string', description: 'Pipeline skill name for role-filtered reads (e.g. forge-code)' },
      query: { type: 'string', description: 'Search query for finding relevant memories (search action)' },
      strategy: { type: 'string', enum: ['semantic', 'keyword', 'graph', 'hybrid', 'auto'], description: 'Retrieval strategy for search (default: hybrid). semantic=vector, keyword=BM25+entity, graph=knowledge graph traversal, hybrid=RRF fusion, auto=intent-based' },
      limit: { type: 'number', description: 'Max results to return for search (default 5)' },
      outputFormat: { type: 'string', enum: ['json', 'markdown'], description: 'Output format for list/sync (default: json for list, markdown for sync)' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;
    const userKey = ctx.userKey || `project:${ctx.projectDocumentId}`;

    // Resolve cross-project access for memories
    let projectDocId = ctx.projectDocumentId;
    if (input.targetProjectSlug) {
      const isReadOnly = action === 'list' || action === 'sync' || action === 'search';
      if (!isReadOnly && !ctx.crossProjectAccess) {
        return `Error: cross-project write access denied for memories. Only list is allowed cross-project without crossProjectAccess.`;
      }
      const targetId = await resolveTargetProject(ctx.strapi, input.targetProjectSlug as string);
      if (!targetId) return `Error: project with slug "${input.targetProjectSlug}" not found`;
      projectDocId = targetId;
    }

    if (action === 'list' || action === 'sync') {
      // Determine role filter: explicit skill param > ctx.pipelineSkill > no filter
      const skill = (input.skill as string) || ctx.pipelineSkill;
      const allowedRoles = skill ? SKILL_MEMORY_ROLES[skill] : undefined;

      const memories = await listMemories(projectDocId, userKey, {
        allowedRoles,
        includeGlobal: true, // always include global memories (CEO directives, cross-project conventions)
      });

      // Determine output format: explicit param > action default
      const format = (input.outputFormat as string) || (action === 'sync' ? 'markdown' : 'json');

      if (format === 'markdown') {
        return exportMemoriesAsMarkdown(memories);
      }

      if (memories.length === 0) return 'No memories stored yet.';
      return JSON.stringify(
        memories.map((m) => ({
          documentId: m.sourceId,
          category: m.category,
          content: m.content,
          scope: m.scope,
          role: m.role || undefined,
          visibility: m.visibility || undefined,
          retrievalCount: m.retrievalCount,
        })),
      );
    }

    if (action === 'add') {
      const data = (input.data && typeof input.data === 'object') ? input.data as Record<string, unknown> : {};
      const category = (input.category || data.category) as string;
      const content = (input.content || data.content) as string;
      if (!category || !content) return 'Error: category and content required for add action';

      const rawRole = (input.role || data.role) as MemoryRole;
      const role = (VALID_ROLES.includes(rawRole) ? rawRole : 'dev') as MemoryRole;
      const rawVisibility = (input.visibility || data.visibility) as MemoryVisibility;
      const visibility = (VALID_VISIBILITIES.includes(rawVisibility) ? rawVisibility : 'all') as MemoryVisibility;
      const rawScope = (input.scope || data.scope) as string;
      const scope = (['user', 'project', 'global'].includes(rawScope) ? rawScope : 'user') as 'user' | 'project' | 'global';

      const { sourceId, isUpdate, degraded } = await addMemory(
        projectDocId, userKey, category, content, scope, 'manual',
        undefined, role, visibility,
      );
      const status = degraded
        ? (isUpdate ? 'updated_without_embedding' : 'added_without_embedding')
        : (isUpdate ? 'updated' : 'added');

      // Await entity extraction with 15s timeout (not fire-and-forget)
      let entities: string[] = [];
      let edges = 0;
      let entityError = false;
      if (!degraded) {
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            extractEntitiesAndEdges(ctx.strapi, projectDocId, {
              type: 'memory',
              text: content,
              sourceId,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Entity extraction timed out (15s)')), 15000);
            }),
          ]);
          clearTimeout(timer);
          entities = result.entities.map((e) => e.name);
          edges = result.edgesStored;
        } catch (err: any) {
          entityError = true;
          ctx.strapi.log.warn(`[memory] entity extraction failed for ${sourceId}: ${err.message || err}`);
        }
      }

      return JSON.stringify({
        documentId: sourceId, role, visibility, scope, status,
        entities, edges,
        ...(entityError && { entityError: true }),
        ...(degraded && { degraded: true }),
      });
    }

    if (action === 'search') {
      const data = (input.data && typeof input.data === 'object') ? input.data as Record<string, unknown> : {};
      const query = (input.query || data.query) as string;
      if (!query) return 'Error: query required for search action';
      const limit = typeof (input.limit ?? data.limit) === 'number' ? (input.limit ?? data.limit) as number : 5;

      const skill = (input.skill || data.skill) as string || ctx.pipelineSkill;
      const allowedRoles = skill ? SKILL_MEMORY_ROLES[skill] : undefined;

      const validStrategies = ['semantic', 'keyword', 'graph', 'hybrid', 'auto'];
      const rawStrategy = (input.strategy || data.strategy) as string;
      const strategy = validStrategies.includes(rawStrategy) ? rawStrategy as any : undefined;

      const memories = await searchMemories(projectDocId, query, {
        limit,
        allowedRoles,
        includeGlobal: true,
        strategy,
      });

      if (memories.length === 0) return 'No relevant memories found.';
      return JSON.stringify(
        memories.map((m) => ({
          documentId: m.sourceId,
          category: m.category,
          content: m.content,
          scope: m.scope,
          role: m.role || undefined,
          visibility: m.visibility || undefined,
          score: m.score,
          retrievalCount: m.retrievalCount,
        })),
      );
    }

    if (action === 'remove') {
      const docId = input.documentId as string;
      if (!docId) return 'Error: documentId required for remove action';
      const removed = await removeMemory(docId);
      return removed ? 'Memory removed.' : 'Memory not found.';
    }

    return `Unknown action: ${action}`;
  },
};
