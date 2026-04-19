import { addMemory, listMemories, removeMemory, searchMemories } from '../../../services/agent/memory';
import { runDreamConsolidation } from '../../../services/memory-dream';

export default {
  async list(ctx: any) {
    const { projectDocumentId } = ctx.query;
    if (!projectDocumentId) {
      return ctx.badRequest('projectDocumentId query parameter is required');
    }

    const userKey = `project:${projectDocumentId}`;
    const memories = await listMemories(projectDocumentId, userKey);

    ctx.body = {
      data: memories.map((m) => ({
        documentId: m.sourceId,
        category: m.category,
        content: m.content,
        scope: m.scope,
        source: m.source,
        role: m.role || null,
        visibility: m.visibility || null,
        retrievalCount: m.retrievalCount,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
    };
  },

  async remove(ctx: any) {
    const { sourceId } = ctx.params;
    if (!sourceId) {
      return ctx.badRequest('sourceId parameter is required');
    }

    const removed = await removeMemory(sourceId);
    if (!removed) {
      return ctx.notFound('Memory not found');
    }

    ctx.body = { data: { ok: true } };
  },

  async add(ctx: any) {
    const projectDocId = ctx.state.forgeProject?.documentId || ctx.query.projectDocumentId;
    if (!projectDocId) {
      return ctx.badRequest('Project context required (API key or projectDocumentId query param)');
    }

    const { content, category = 'correction', role = 'dev', visibility = 'all', scope = 'project' } = ctx.request.body || {};
    if (!content || typeof content !== 'string') {
      return ctx.badRequest('content is required in request body');
    }

    const validCategories = ['preference', 'correction', 'convention'];
    const validRoles = ['ceo', 'cto', 'pm', 'po', 'techlead', 'dev', 'qa', 'devops'];
    const validVisibilities = ['down', 'same', 'up', 'all'];
    const validScopes = ['user', 'project', 'global'];

    const userKey = `project:${projectDocId}`;
    const result = await addMemory(
      projectDocId,
      userKey,
      validCategories.includes(category) ? category : 'correction',
      content,
      validScopes.includes(scope) ? scope : 'project',
      'pipeline',
      undefined,
      validRoles.includes(role) ? role : 'dev',
      validVisibilities.includes(visibility) ? visibility : 'all',
    );

    ctx.body = { data: { sourceId: result.sourceId, isUpdate: result.isUpdate } };
  },

  async search(ctx: any) {
    const projectDocId = ctx.state.forgeProject?.documentId || ctx.query.projectDocumentId;
    if (!projectDocId) {
      return ctx.badRequest('Project context required (API key or projectDocumentId query param)');
    }

    const { query, strategy, limit, skill } = ctx.request.body || {};
    if (!query) {
      return ctx.badRequest('query is required in request body');
    }

    const validStrategies = ['semantic', 'keyword', 'graph', 'hybrid', 'auto'];
    const memories = await searchMemories(projectDocId, query, {
      limit: typeof limit === 'number' ? limit : 5,
      includeGlobal: true,
      strategy: validStrategies.includes(strategy) ? strategy : undefined,
      allowedRoles: skill ? (await import('../../../services/agent/memory')).SKILL_MEMORY_ROLES[skill] : undefined,
    });

    ctx.body = {
      data: memories.map((m) => ({
        documentId: m.sourceId,
        category: m.category,
        content: m.content,
        scope: m.scope,
        role: m.role || null,
        visibility: m.visibility || null,
        score: m.score,
        retrievalCount: m.retrievalCount,
      })),
    };
  },

  async dream(ctx: any) {
    const { projectDocId } = ctx.request.body;
    if (!projectDocId) {
      return ctx.badRequest('projectDocId is required in request body');
    }

    const result = await runDreamConsolidation((globalThis as any).strapi, projectDocId);
    ctx.body = { data: result };
  },
};
