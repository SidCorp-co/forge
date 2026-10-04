import { forgeKnowledgeTool } from '../../mcp/tools/forge-knowledge.js';
import { forgeMemoryTool } from '../../mcp/tools/forge-memory.js';
import {
  forgeMetricsProjectStepDurationsTool,
  forgeMetricsProjectTimeseriesTool,
} from '../../mcp/tools/forge-metrics.js';
import { forgeProjectPipelineRunsTool } from '../../mcp/tools/forge-project-pipeline-runs.js';
import type { McpContext } from '../../mcp/tools/lib.js';
import { forgeChannelTool } from './forge-channel-tool.js';
import { forgeCliTool } from './forge-cli-tool.js';
import { forgeMemoryNoteTool } from './forge-memory-note-tool.js';
import { forgePreferencesTool } from './forge-preferences-tool.js';
import { buildToolset, type ChatToolSpec, type ChatToolset } from './mcp-adapter.js';

/** Curated allowlist exposed to the chat model. */
export const CHAT_TOOL_ALLOWLIST: ChatToolSpec[] = [
  { factory: forgeCliTool },
  {
    factory: forgeKnowledgeTool,
    allowedActions: ['list', 'get', 'search'],
  },
  { factory: forgeMemoryTool, allowedActions: ['search'] },
  { factory: forgeProjectPipelineRunsTool },
  { factory: forgeMetricsProjectStepDurationsTool },
  { factory: forgeMetricsProjectTimeseriesTool },
  { factory: forgePreferencesTool },
  { factory: forgeMemoryNoteTool },
  { factory: forgeChannelTool },
];

/** Build the OpenAI toolset for a project-scoped chat context. */
export function buildProjectToolset(ctx: McpContext): ChatToolset {
  return buildToolset(ctx, CHAT_TOOL_ALLOWLIST);
}
