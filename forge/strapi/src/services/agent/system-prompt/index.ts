export type { PromptContext, RelevantContextEntry } from './types';

import type { PromptContext } from './types';
import {
  layerIdentity,
  layerCoreBehavior,
  layerBehavior,
  layerTools,
  layerAvailableSkills,
  layerProjectContext,
  layerGuidelines,
  layerRollingStats,
  layerCrossProjectHealth,
  layerEscalationMemories,
} from './static-layers';
import {
  layerRuntime,
  layerLanguage,
  layerRelevantContext,
  layerQueryStrategy,
  layerKnowledgeGraph,
  layerMcpContext,
  layerPageContext,
  layerHubContext,
} from './dynamic-layers';

export function buildSystemPrompt(ctx: PromptContext): string {
  // Order: static layers first (cacheable prefix), dynamic layers last.
  // LLM prompt caching matches on prefix — identical prefix = cache hit.
  const layers = [
    // Static (same across all requests for a project)
    layerIdentity(ctx),       // 1. Project name
    layerCoreBehavior(ctx),   // 2. Core behavior (derives from config/tools)
    layerBehavior(ctx),       // 3. Instructions (conditional on tools)
    layerTools(ctx),          // 4. Tool definitions (constant)
    layerAvailableSkills(ctx), // 4.5. Available skills (when forge_skills enabled)
    layerProjectContext(ctx), // 5. Project description, repos, knowledge (rarely changes)
    layerGuidelines(ctx),     // 6. Project agent prompt (rarely changes)
    layerRollingStats(ctx),   // 6.5. Project stats (semi-static)
    layerCrossProjectHealth(ctx), // 6.6. Cross-project health (CEO only)
    layerEscalationMemories(ctx), // 6.7. Escalation memories (CEO only)
    // Dynamic (changes per user/session — placed last to preserve cache prefix)
    layerRuntime(ctx),         // 7. Date, model, source
    layerLanguage(ctx),        // 8. Output language preference
    layerRelevantContext(ctx), // 9. RAG context (per-query, includes memories as source_type: "memory")
    layerQueryStrategy(ctx),   // 10. Intent-aware strategy hint (per-query)
    layerKnowledgeGraph(ctx),  // 11. Knowledge graph edges (entity relationships)
    ctx.pageContext ? layerPageContext(ctx.pageContext) : '',
    ctx.hubContext ? layerHubContext(ctx.hubContext) : '',
    ctx.hasMcpServers ? layerMcpContext(ctx) : '',
  ].filter(Boolean);

  return layers.join('\n\n');
}
