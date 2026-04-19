import type { PromptContext } from './types';

// Layer 5: Knowledge Graph edges (entity relationships)
export function layerKnowledgeGraph(ctx: PromptContext): string {
  if (!ctx.edgeContext) return '';
  return `## Knowledge Graph\nKnown entity relationships in this project:\n${ctx.edgeContext}`;
}

// Layer: RAG Context (dynamic, inserted before runtime)
export function layerRelevantContext(ctx: PromptContext): string {
  if (!ctx.relevantContext?.length) return '';

  const MAX_CHARS = 6000;
  const entries: string[] = [];
  let totalChars = 0;

  // Group by source_type for readability
  const grouped = new Map<string, typeof ctx.relevantContext>();
  for (const entry of ctx.relevantContext) {
    const group = grouped.get(entry.sourceType) ?? [];
    group.push(entry);
    grouped.set(entry.sourceType, group);
  }

  for (const [, items] of grouped) {
    for (const item of items) {
      const text = item.text.slice(0, 800);
      if (totalChars + text.length > MAX_CHARS) break;

      // Build metadata header for structured context
      const meta = item.metadata || {};
      const attrs: string[] = [`source="${item.sourceType}:${item.sourceId}"`];
      if (meta.title) attrs.push(`title="${meta.title}"`);
      if (meta.status) attrs.push(`status="${meta.status}"`);
      if (meta.priority) attrs.push(`priority="${meta.priority}"`);
      if (meta.category) attrs.push(`category="${meta.category}"`);

      entries.push(`<context ${attrs.join(' ')}>\n${text}\n</context>`);
      totalChars += text.length;
    }
  }

  if (entries.length === 0) return '';
  return `## Relevant Context\nRelevant project data retrieved for this query. Use this to answer directly when possible — avoid redundant tool calls for data already shown here.\n\n${entries.join('\n\n')}`;
}

// Layer 7: Runtime Info (use date-only for better cache hits — exact time changes every call)
export function layerRuntime(ctx: PromptContext): string {
  return [
    `## Runtime`,
    `Current date: ${new Date().toISOString().split('T')[0]}`,
    `Model: ${ctx.model}`,
    `Session source: ${ctx.sessionSource}`,
  ].join('\n');
}

// Layer: Output Language (dynamic, changes per user/message)
export function layerLanguage(ctx: PromptContext): string {
  if (!ctx.preferredLanguage) return '';
  return `## Output Language\nAlways respond in **${ctx.preferredLanguage}**. Match the user's language naturally.`;
}

// Layer 9: Intent-aware Query Strategy (dynamic, placed after RAG context)
export function layerQueryStrategy(ctx: PromptContext): string {
  if (!ctx.queryIntent) return '';

  // Config override (from domain template or custom config)
  const configStrategy = ctx.agentConfig?.queryStrategies?.[ctx.queryIntent];
  if (configStrategy) {
    let strategy = configStrategy;

    // Append tool-usage hints when pre-computed data is unavailable
    const needsToolFallback = ['SUMMARY', 'LOOKUP'].includes(ctx.queryIntent) && !ctx.rollingStats?.totalIssues;
    if (needsToolFallback) {
      strategy += '\nNo pre-computed stats are available. You MUST use tools to fetch the data needed to answer — do NOT say you lack data without trying tools first.';
    }

    // For MCP projects, ensure the agent knows to use MCP tools
    if (ctx.hasMcpServers) {
      const mcpTools = ctx.tools.filter((t) => t.name.includes('__')).map((t) => t.name);
      if (mcpTools.length > 0) {
        strategy += `\nThis project's data lives in a connected external service. Use MCP tools to query it: ${mcpTools.join(', ')}`;
      }
      // Guide agent to use code_run for analytics instead of paginating
      const hasCodeRun = ctx.tools.some((t) => t.name === 'code_run');
      if (hasCodeRun && ctx.queryIntent && ['SUMMARY', 'LOOKUP'].includes(ctx.queryIntent)) {
        strategy += `\nFor analytical queries (top N, aggregation, ranking, comparison): fetch data with ONE MCP call (use large page size or relevant filters), then pipe the results into code_run to compute the answer. Do NOT paginate through all pages manually — fetch once, compute with code.`;
      }
    }

    return `## Query Strategy: ${ctx.queryIntent}\n${strategy}`;
  }

  // Legacy: auto-detect from tool names
  const hasForgeIssues = ctx.tools.some((t) => t.name === 'forge_issues');
  const hasMcp = ctx.hasMcpServers;
  const mcpToolNames = hasMcp ? ctx.tools.filter((t) => t.name.includes('__')).map((t) => t.name) : [];
  const toolHint = hasMcp && mcpToolNames.length > 0
    ? `\nAvailable MCP tools: ${mcpToolNames.join(', ')}\nUse these tools proactively — the data lives in the connected service.`
    : '';

  const strategies: Record<string, string> = {
    CHAT: [
      `## Query Strategy: Conversation`,
      `This is a casual message (greeting, thanks, confirmation). Respond naturally and conversationally.`,
      `No tool calls or data lookups are needed.`,
    ].join('\n'),

    ACTION: [
      `## Query Strategy: Direct Action`,
      `The user is giving a command, confirming an action, or answering your question.`,
      `Look at conversation history to understand what they want done, then call the appropriate tool.`,
      `Do NOT respond with text explaining what you could do — execute the action with a tool call.`,
      `Do NOT ask for clarification if the intent is clear from context or memories. Execute immediately.`,
      ...(ctx.tools && ctx.tools.length > 0
        ? [``, `Available tools: ${ctx.tools.map((t) => t.name).join(', ')}`]
        : []),
    ].join('\n'),

    LOOKUP: hasForgeIssues ? [
      `## Query Strategy: Filtered Lookup`,
      `The user wants a filtered list of issues (by status, priority, category, or type).`,
      `Use forge_issues with list action and appropriate filters to get exact, complete results.`,
      `Do NOT rely on context — tool filters give authoritative data. Common filters:`,
      `- status: ${ctx.agentConfig?.statuses?.join(', ') || '(any)'}`,
      `- priority: ${ctx.agentConfig?.priorities?.join(', ') || '(any)'}`,
      `- category: ${ctx.agentConfig?.categories?.join(', ') || '(any)'}`,
    ].join('\n') : [
      `## Query Strategy: Filtered Lookup`,
      `The user wants a filtered list of data. Use available tools with appropriate filters.`,
      `Do NOT rely on context alone — call tools to get authoritative, filtered results.`,
      toolHint,
    ].filter(Boolean).join('\n'),

    SEARCH: [
      `## Query Strategy: Semantic Search`,
      `The user is searching for specific information or exploring by topic.`,
      `Check the Relevant Context section first — it contains pre-fetched data matching this query.`,
      `Use context to answer directly when possible. Only use tools for data not already present.`,
      ...(hasMcp ? [`If context is insufficient, use MCP tools to query the connected service directly.`] : []),
    ].join('\n'),

    CREATE: hasForgeIssues ? [
      `## Query Strategy: Issue Creation`,
      `The user wants to create a new issue. Relevant skill guidelines are provided in context.`,
      `Follow the creation workflow: load skills → draft → present to user → wait for approval → create.`,
    ].join('\n') : [
      `## Query Strategy: Creation`,
      `The user wants to create something. Use available tools to fulfill the request.`,
      toolHint,
    ].filter(Boolean).join('\n'),

    SUMMARY: hasForgeIssues ? [
      `## Query Strategy: Project Summary`,
      `The user is asking about project status, statistics, or health.`,
      ...(ctx.rollingStats?.totalIssues
        ? [`Use the Project Stats section to answer — it contains up-to-date counts, blockers, and stale issues.`,
           `No additional tool calls are needed for aggregate data already shown in stats.`]
        : [`No pre-computed stats are available. Use tools (forge_issues list, etc.) to fetch the data needed to answer.`,
           `Try broad filters first, then narrow down.`]),
    ].join('\n') : [
      `## Query Strategy: Project Summary`,
      `The user is asking about project status, statistics, or overview.`,
      `You MUST use tools to fetch real data before responding — do NOT answer from memory or say you don't have data.`,
      `Check context for any pre-fetched data, then call tools for anything missing.`,
      toolHint,
    ].filter(Boolean).join('\n'),
  };

  return strategies[ctx.queryIntent] || '';
}

// Layer: MCP External Services (dynamic, based on project config)
export function layerMcpContext(ctx: PromptContext): string {
  const lines = ['## Connected External Services'];
  lines.push('This project has connected external services via MCP. Tools from each service are prefixed with the server key (e.g. `serverkey__tool_name`).');
  lines.push('When users ask about tasks, projects, or data — **prioritize MCP tools over forge_issues/forge_tasks** since the primary data lives in the external service.');

  if (ctx.mcpServers) {
    const serverKeys = Object.keys(ctx.mcpServers);
    lines.push(`\nConnected servers: ${serverKeys.map(k => `**${k}**`).join(', ')}`);
  }

  lines.push('');
  lines.push('When external data (hub_task, hub_project, hub_comment, etc.) appears in <context>, use it to answer directly — only call MCP tools when the context is insufficient or the user needs real-time data.');

  return lines.join('\n');
}

// Layer: Web page context (tells agent what page the user is viewing)
export function layerPageContext(pageContext: Record<string, unknown>): string {
  // Only include key identifiers — the agent can use tools to fetch full details
  const compact: string[] = [];
  for (const [key, value] of Object.entries(pageContext)) {
    if (typeof value === 'string' && value.length > 100) continue; // skip long text
    compact.push(`${key}: ${value}`);
  }
  if (compact.length === 0) return '';
  return `## Page Context\nUser is viewing: ${compact.join(' | ')}\nAssume questions relate to this context unless stated otherwise.`;
}

// Layer: Hub/Widget page context (tells agent where the user is)
export function layerHubContext(hubContext: Record<string, unknown>): string {
  const lines = ['## Current Page Context'];
  lines.push('The user is chatting from an embedded widget. Use this context to scope your responses:');
  for (const [key, value] of Object.entries(hubContext)) {
    lines.push(`- **${key}**: ${value}`);
  }
  lines.push('');
  lines.push('When the user asks vague questions like "show tasks" or "what is pending", use this context to filter results (e.g. filter by the current projectId or page).');
  return lines.join('\n');
}
