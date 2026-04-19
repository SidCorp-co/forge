import { getToolDefinitions, buildSystemPrompt, DEFAULT_AGENT_CONFIG } from '../../../services/agent';
import type { Message, PromptContext, RelevantContextEntry } from '../../../services/agent';
import { sanitizeContent } from '../../../services/embeddings';
import { rerank } from '../../../services/embeddings/reranker';
import { multiStrategySearch } from '../../../services/embeddings/multi-search';
import { crossEncoderRerank, buildScoreMap } from '../../../services/embeddings/cross-encoder';
import { ragGate } from '../../../services/rag-gate';
import type { QueryIntent } from '../../../services/rag-gate';
import { isRollingStatsFresh, recomputeRollingStats } from '../../../services/rolling-summary';
import { formatRagEntries } from '../../../services/rag-formatter';
import { resolvePreferredLanguage } from '../../../services/language-detect';
import { touchMemories } from '../../../services/agent/memory';
import { queryGraphContext, formatGraphContextForPrompt } from '../../../services/knowledge-graph';

// RAG retrieval constants
const RAG_TOP_K = 20;
const RAG_RERANK_TOP = 8;
const RAG_MIN_QUERY_LENGTH = 10;
const RAG_MAX_DIRECT_ISSUES = 5;
const RAG_MAX_RELATED_IDS = 10;
const RAG_HISTORY_CHARS_THRESHOLD = 60_000;
const RAG_ENTRIES_LARGE_HISTORY = 4;
const RAG_ENTRIES_NORMAL = 8;
const MAX_HISTORY_MESSAGES = 100;

/**
 * Build the full messages array and system prompt for the agent.
 */
export async function buildChatPrompt(
  strapi: any,
  project: any,
  session: any,
  message: string,
  model: string,
  userKey: string,
  hubContext?: Record<string, unknown>,
  widgetUserId?: string,
  pageContext?: Record<string, unknown>,
): Promise<{ allMessages: Message[]; systemPrompt: string; ragContext: RelevantContextEntry[]; queryIntent?: string; condensedQuery?: string }> {
  // Build messages from session history + new user message (truncate long histories)
  const fullHistory: Message[] = session.messages || [];
  const history = fullHistory.length > MAX_HISTORY_MESSAGES
    ? fullHistory.slice(-MAX_HISTORY_MESSAGES)
    : fullHistory;
  const userMessage: Message = { role: 'user', content: message };
  const allMessages: Message[] = [...history, userMessage];

  const agentConfig = project.agentConfig || DEFAULT_AGENT_CONFIG;

  // RAG retrieval with intent classification
  // Memories (source_type: "memory") are now retrieved through RAG pipeline alongside issues/skills
  // Note: page context (issue/task being viewed) is in the system prompt — the agent uses tools to fetch details
  const { context: relevantContext, intent: queryIntent, condensedQuery } = await retrieveRagContext(strapi, project, message, history, agentConfig.intentExamples, widgetUserId);

  // Touch memory retrieval counts (fire-and-forget)
  const memorySourceIds = relevantContext
    .filter((r) => r.sourceType === 'memory')
    .map((r) => r.sourceId);
  if (memorySourceIds.length > 0) {
    touchMemories(memorySourceIds).catch(() => {});
  }

  // Multi-hop knowledge graph expansion: extract entities, traverse 2 hops with PageRank scoring
  let edgeContext = '';
  try {
    const entities = extractEntityNamesFromContext(message, relevantContext);
    if (entities.length > 0) {
      const graphCtx = await queryGraphContext(strapi, project.documentId, entities, 2);
      edgeContext = formatGraphContextForPrompt(graphCtx);
    }
  } catch (err) {
    strapi.log.warn(`[rag] graph expansion failed: ${err}`);
  }

  // Resolve user's preferred output language (reads from user-preference DB record, persists on first detection)
  const preferredLanguage = await resolvePreferredLanguage(strapi, project.documentId, userKey, message);

  // Build layered system prompt
  const toolDefs = getToolDefinitions(agentConfig);
  // Fetch available skills when forge_skills is enabled
  let availableSkills: { name: string; description: string }[] | undefined;
  if (!agentConfig.enabledTools?.length || agentConfig.enabledTools.includes('forge_skills')) {
    try {
      const skills = await strapi.documents('api::skill.skill' as any).findMany({
        filters: {
          $and: [
            {
              $or: [
                { project: { documentId: { $eq: project.documentId } } },
                { isGlobal: { $eq: true } },
              ],
            },
            { target: { $in: ['cloud', 'all'] } },
          ],
        },
        fields: ['name', 'description'],
      });
      if (skills?.length) {
        let filtered = skills as any[];
        if (agentConfig.enabledSkills?.length) {
          const enabled = new Set(agentConfig.enabledSkills);
          filtered = filtered.filter((s: any) => enabled.has(s.name));
        }
        if (filtered.length) {
          availableSkills = filtered.map((s: any) => ({ name: s.name, description: s.description || '' }));
        }
      }
    } catch (err) {
      strapi.log.warn(`Skills fetch failed: ${err}`);
    }
  }

  // Cross-project health + escalations for CEO agent
  let crossProjectHealth: any[] | undefined;
  let escalationMemories: { project: string; content: string; role: string }[] | undefined;
  if (project.crossProjectAccess) {
    try {
      crossProjectHealth = await fetchCrossProjectHealth(strapi);
    } catch (err) {
      strapi.log.warn(`[ceo] cross-project health fetch failed: ${err}`);
    }
    try {
      escalationMemories = await fetchEscalationMemories(strapi);
    } catch (err) {
      strapi.log.warn(`[ceo] escalation memories fetch failed: ${err}`);
    }
  }

  const promptCtx: PromptContext = {
    projectName: project.name || project.slug,
    projectDescription: project.description,
    agentPrompt: project.agentPrompt,
    knowledgeIndex: project.knowledgeIndex,
    repos: project.repos,
    rollingStats: project.rollingStats,
    agentConfig,
    userKey,
    sessionSource: (session.source || 'web') as 'web' | 'widget',
    edgeContext,
    model,
    tools: toolDefs,
    totalToolCalls: session.metadata?.totalToolCalls || 0,
    relevantContext,
    queryIntent,
    preferredLanguage: preferredLanguage || undefined,
    hubContext,
    hasMcpServers: !!(project.mcpServers && Object.keys(project.mcpServers).length > 0),
    mcpServers: project.mcpServers,
    availableSkills,
    pageContext,
    crossProjectHealth,
    escalationMemories,
  };
  const systemPrompt = buildSystemPrompt(promptCtx);

  return { allMessages, systemPrompt, ragContext: relevantContext, queryIntent, condensedQuery };
}

interface RagResult {
  context: RelevantContextEntry[];
  intent?: QueryIntent;
  condensedQuery?: string;
  searchQueryEn?: string;
}

/**
 * Run RAG retrieval: intent classification + multi-strategy search + reranking.
 */
async function retrieveRagContext(
  strapi: any,
  project: any,
  message: string,
  history: Message[],
  intentExamples?: string[],
  widgetUserId?: string,
): Promise<RagResult> {
  try {
    const rawQuery = message.replace(/ISS-\d+/g, '').trim();
    const historyTurns = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: typeof m.content === 'string' ? m.content : '' }));

    if (rawQuery.length <= RAG_MIN_QUERY_LENGTH) {
      // Short messages still need intent classification (e.g. "deploy", "do it", "yes")
      // Skip RAG search but classify intent so the agent gets the right strategy hint
      if (history.length > 0 && rawQuery.length > 0) {
        const { intent, standaloneQuery, wasCondensed } = await ragGate(strapi, rawQuery, historyTurns, intentExamples);
        return { context: [], intent, condensedQuery: wasCondensed ? standaloneQuery : undefined };
      }
      return { context: [] };
    }

    // Single LLM call: classify intent + condense query + English search query in one pass
    const { intent, standaloneQuery, wasCondensed, searchQueryEn } = await ragGate(strapi, rawQuery, historyTurns, intentExamples);
    const searchQuery = standaloneQuery;

    const cq = wasCondensed ? standaloneQuery : undefined;

    // CHAT → no RAG needed (greeting / small talk)
    if (intent === 'CHAT') return { context: [], intent, condensedQuery: cq };

    // ACTION → skip RAG search but return intent so strategy hint is included
    // The agent still has tools (set up in chat controller) and conversation history provides context
    if (intent === 'ACTION') return { context: [], intent, condensedQuery: cq };

    // LOOKUP → skip RAG for pure Forge projects (agent uses forge_issues filters)
    // For projects with MCP servers, fall through to SEARCH so hub embeddings are included
    const hasMcp = project.mcpServers && Object.keys(project.mcpServers).length > 0;
    if (intent === 'LOOKUP' && !hasMcp) {
      strapi.log.info(`[rag] LOOKUP intent — skipping RAG, agent will use tool filters`);
      return { context: [], intent, condensedQuery: cq };
    }

    // CREATE → only search skills for guidelines
    if (intent === 'CREATE') {
      const { results } = await multiStrategySearch(strapi, project.documentId, searchQuery, 5, ['skill']);
      const context = formatRagEntries(results.slice(0, 3).map((r) => ({
        sourceType: r.payload.source_type,
        sourceId: r.payload.source_id,
        text: sanitizeContent(r.payload.text),
        score: r.score,
        metadata: r.payload.metadata,
      })));
      return { context, intent, condensedQuery: cq };
    }

    // SUMMARY → use rolling stats if fresh, otherwise recompute and fall through
    // For MCP projects, always fall through to SEARCH so hub embeddings are included
    if (intent === 'SUMMARY') {
      if (isRollingStatsFresh(project.rollingStats) && !hasMcp) {
        strapi.log.info(`[rag] SUMMARY intent — using fresh rolling stats`);
        return { context: [], intent, condensedQuery: cq };
      }
      // Fire-and-forget recompute, fall through to SEARCH
      setImmediate(() => {
        recomputeRollingStats(strapi, project.documentId).catch((err: any) =>
          strapi.log.warn(`[rolling-stats] async recompute: ${err.message}`));
      });
    }

    // SEARCH (and SUMMARY fallback) → full multi-strategy pipeline
    const { results: raw, breakdown } = await multiStrategySearch(
      strapi, project.documentId, searchQuery, RAG_TOP_K,
    );

    if (raw.length === 0) {
      strapi.log.info(`[rag] query="${searchQuery.slice(0, 60)}" → 0 results`);
      return { context: [], intent, condensedQuery: cq };
    }

    const candidates = [...raw];
    // Fallback: direct issue-to-issue relation expansion (graph traversal is in buildChatPrompt)
    await expandWithRelatedIssues(strapi, project.documentId, candidates);

    const ceResults = await crossEncoderRerank(searchQuery, candidates, RAG_RERANK_TOP * 2);
    const ceScores = ceResults ? buildScoreMap(ceResults) : undefined;
    const ranked = rerank(candidates, searchQuery, RAG_RERANK_TOP, widgetUserId, ceScores);

    // Guarantee schema context for MCP projects: always inject best schema section.
    // Vietnamese queries often have zero semantic overlap with English API schema text,
    // so schema may not appear in raw results at all — do a targeted search if needed.
    if (hasMcp) {
      let schemaHits = raw.filter((r) => r.payload.source_type === 'mcp_schema');
      if (schemaHits.length === 0) {
        // Targeted search: schema sections only, using English query for better semantic match
        const schemaSearchQuery = searchQueryEn || searchQuery;
        const { results: schemaResults } = await multiStrategySearch(
          strapi, project.documentId, schemaSearchQuery, 5, ['mcp_schema'],
        );
        schemaHits = schemaResults;
      }
      // Inject top 2 schema sections (different domains often needed, e.g. CANDIDATES + CAMPAIGNS)
      const existingSchemaIds = new Set(ranked.filter(r => r.payload.source_type === 'mcp_schema').map(r => r.payload.source_id));
      schemaHits
        .sort((a, b) => b.score - a.score)
        .filter((r) => !existingSchemaIds.has(r.payload.source_id))
        .slice(0, 2)
        .forEach((r) => {
          ranked.push({ ...r, finalScore: r.score + 0.20 } as any);
        });
    }

    const historyChars = JSON.stringify(history).length;
    const maxEntries = historyChars > RAG_HISTORY_CHARS_THRESHOLD
      ? RAG_ENTRIES_LARGE_HISTORY
      : RAG_ENTRIES_NORMAL;

    const context = formatRagEntries(ranked.slice(0, maxEntries).map((r) => ({
      sourceType: r.payload.source_type,
      sourceId: r.payload.source_id,
      text: sanitizeContent(r.payload.text),
      score: (r as any).finalScore ?? r.score,
      metadata: r.payload.metadata,
    })));

    const types = context.reduce((acc, c) => { acc[c.sourceType] = (acc[c.sourceType] || 0) + 1; return acc; }, {} as Record<string, number>);
    const typeSummary = Object.entries(types).map(([t, n]) => `${n} ${t}`).join(', ');
    strapi.log.info(`[rag] entity: ${breakdown.entity}, vector: ${breakdown.vector}, bm25: ${breakdown.bm25} → merged: ${raw.length} unique, ${context.length} injected (${typeSummary})`);

    return { context, intent, condensedQuery: cq, searchQueryEn };
  } catch (err: any) {
    strapi.log.error(`[rag] retrieval failed: ${err?.message || err}`, { stack: err?.stack?.split('\n').slice(0, 5).join('\n') });
    return { context: [] };
  }
}

/**
 * Extract entity names from the query and RAG results for knowledge graph expansion.
 */
function extractEntityNamesFromContext(query: string, context: RelevantContextEntry[]): string[] {
  const entities = new Set<string>();

  // Extract significant words from query (3+ chars, not common words)
  const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'what', 'how', 'show', 'list', 'get', 'find', 'with', 'this', 'that', 'from', 'they', 'been', 'said', 'each', 'which', 'their', 'will', 'other', 'about', 'many', 'them', 'then', 'these', 'some', 'would', 'make', 'like', 'could', 'into', 'than', 'its']);
  const words = query.toLowerCase().split(/[\s,;.!?/]+/).filter((w) => w.length >= 3 && !stopWords.has(w));
  for (const w of words.slice(0, 5)) entities.add(w);

  // Extract from RAG metadata (titles, sourceIds)
  for (const entry of context.slice(0, 5)) {
    if (entry.metadata?.title) {
      const titleWords = entry.metadata.title.toLowerCase().split(/[\s/]+/).filter((w: string) => w.length >= 3);
      for (const w of titleWords.slice(0, 3)) entities.add(w);
    }
  }

  return Array.from(entities).slice(0, 10);
}

/**
 * 1-hop relation traversal: for matched issues, fetch their related issues
 * and add them as candidates with a base score.
 */
async function expandWithRelatedIssues(
  strapi: any,
  projectId: string,
  candidates: any[],
): Promise<void> {
  const seenIds = new Set(candidates.map((r) => r.payload.source_id));
  const issueResults = candidates.filter((r) => r.payload.source_type === 'issue');
  if (issueResults.length === 0) return;

  try {
    const issueDocIds = issueResults.slice(0, RAG_MAX_DIRECT_ISSUES).map((r: any) => r.payload.source_id);
    const issues = await strapi.documents('api::issue.issue' as any).findMany({
      filters: { documentId: { $in: issueDocIds } },
      fields: ['documentId', 'relations'],
    });

    const relatedDocIds: string[] = [];
    for (const issue of issues) {
      for (const rel of (Array.isArray(issue.relations) ? issue.relations : [])) {
        if (rel.targetDocumentId && !seenIds.has(rel.targetDocumentId)) {
          seenIds.add(rel.targetDocumentId);
          relatedDocIds.push(rel.targetDocumentId);
        }
      }
    }

    if (relatedDocIds.length === 0) return;

    const relatedIssues = await strapi.documents('api::issue.issue' as any).findMany({
      filters: { documentId: { $in: relatedDocIds.slice(0, RAG_MAX_RELATED_IDS) } },
      fields: ['documentId', 'title', 'description', 'status', 'priority', 'acceptanceCriteria', 'updatedAt'],
    });

    for (const ri of relatedIssues) {
      const text = [ri.title, ri.description].filter(Boolean).join('\n\n');
      candidates.push({
        score: 0.5,
        payload: {
          source_type: 'issue',
          source_id: ri.documentId,
          text: sanitizeContent(text),
          project_id: projectId,
          chunk_index: 0,
          metadata: {
            title: ri.title,
            status: ri.status,
            priority: ri.priority,
            hasAC: !!ri.acceptanceCriteria,
            updatedAt: ri.updatedAt,
          },
        },
        _fromRelation: true,
      });
    }
  } catch (err) {
    strapi.log.warn(`[rag] 1-hop relation traversal failed: ${err}`);
  }
}

/**
 * Fetch cross-project health data for the CEO agent system prompt.
 * Queries all projects' rolling stats and computes a lightweight summary.
 */
async function fetchCrossProjectHealth(strapi: any): Promise<any[]> {
  const ISSUE_UID = 'api::issue.issue' as any;
  const PROJECT_UID = 'api::project.project' as any;

  const projects = await strapi.documents(PROJECT_UID).findMany({
    filters: { crossProjectAccess: { $ne: true } }, // exclude the CEO project itself
    fields: ['documentId', 'name', 'slug', 'rollingStats'],
    limit: 20, // Cap to avoid unbounded parallel queries (fix #3)
  });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  return Promise.all(
    projects.map(async (project: any) => {
      // Prefer cached rollingStats if fresh (< 1 hour old)
      if (project.rollingStats?.updatedAt) {
        const age = Date.now() - new Date(project.rollingStats.updatedAt).getTime();
        if (age < 60 * 60 * 1000) {
          const stats = project.rollingStats;
          // Compute throughput from closed count (rollingStats doesn't store throughput directly)
          const closedCount = stats.statusCounts?.closed ?? 0;
          const throughput = Math.round((closedCount / 30) * 7);
          return {
            projectName: project.name,
            projectSlug: project.slug,
            throughput,
            totalActive: (stats.totalIssues ?? 0) - (stats.statusCounts?.closed ?? 0) - (stats.statusCounts?.released ?? 0),
            statusDistribution: stats.statusCounts || {},
            blockers: (stats.blockers || []).map((b: any) => ({
              issueId: `ISS-${b.id || '?'}`,
              documentId: b.documentId,
              status: b.status,
            })),
            pendingEscalations: stats.statusCounts?.waiting ?? 0,
            avgCycleTimeDays: 0,
          };
        }
      }

      // Fallback: compute from issues directly
      const issues: any[] = await strapi.documents(ISSUE_UID).findMany({
        filters: {
          project: { documentId: { $eq: project.documentId } },
          updatedAt: { $gte: thirtyDaysAgo },
        },
        fields: ['documentId', 'id', 'status', 'priority', 'relations', 'createdAt', 'updatedAt'],
        limit: 500,
      });

      const statusDistribution: Record<string, number> = {};
      for (const issue of issues) {
        statusDistribution[issue.status] = (statusDistribution[issue.status] || 0) + 1;
      }

      const closed = issues.filter((i: any) => i.status === 'closed');
      const throughput = Math.round((closed.length / 30) * 7);

      const blockers = issues.filter((i: any) => {
        if (!['confirmed', 'clarified', 'approved'].includes(i.status)) return false;
        const relations: any[] = Array.isArray(i.relations) ? i.relations : [];
        return relations.some((r: any) => r.type === 'blocked_by' || r.type === 'depends_on');
      });

      let avgCycleTimeDays = 0;
      if (closed.length > 0) {
        const totalMs = closed.reduce((sum: number, i: any) => {
          return sum + (new Date(i.updatedAt).getTime() - new Date(i.createdAt).getTime());
        }, 0);
        avgCycleTimeDays = Math.round(totalMs / closed.length / (24 * 60 * 60 * 1000) * 10) / 10;
      }

      return {
        projectName: project.name,
        projectSlug: project.slug,
        throughput,
        totalActive: issues.filter((i: any) => !['closed', 'released'].includes(i.status)).length,
        statusDistribution,
        blockers: blockers.map((i: any) => ({
          issueId: `ISS-${i.id}`,
          documentId: i.documentId,
          status: i.status,
        })),
        pendingEscalations: issues.filter((i: any) => i.status === 'waiting').length,
        avgCycleTimeDays,
      };
    }),
  );
}

/**
 * Fetch escalation memories (visibility: up) from all projects for the CEO agent.
 */
async function fetchEscalationMemories(strapi: any): Promise<{ project: string; content: string; role: string }[]> {
  try {
    const { getQdrantClient } = await import('../../../services/embeddings/qdrant');
    const qdrant = getQdrantClient();
    if (!qdrant) return [];

    const result = await qdrant.scroll('forge_embeddings', {
      filter: {
        must: [
          { key: 'source_type', match: { value: 'memory' } },
          { key: 'metadata.visibility', match: { value: 'up' } },
        ],
      },
      with_payload: true,
      limit: 20,
    });

    // Resolve project names for display
    const PROJECT_UID = 'api::project.project' as any;
    const projectCache = new Map<string, string>();

    const memories: { project: string; content: string; role: string }[] = [];
    for (const point of (result.points || [])) {
      const payload = point.payload as any;
      const meta = payload?.metadata || {};
      const projectId = payload?.project_id;

      let projectName = projectCache.get(projectId) || projectId;
      if (!projectCache.has(projectId) && projectId && projectId !== '__global__') {
        try {
          const p = await strapi.documents(PROJECT_UID).findOne({
            documentId: projectId,
            fields: ['name', 'slug'],
          });
          projectName = p?.name || p?.slug || projectId;
          projectCache.set(projectId, projectName);
        } catch {
          projectCache.set(projectId, projectId);
        }
      }

      memories.push({
        project: projectName,
        content: payload?.text || '',
        role: meta.role || 'unknown',
      });
    }

    return memories;
  } catch {
    return [];
  }
}

