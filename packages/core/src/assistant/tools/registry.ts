import { forgeChannelTool } from '../../ecosystem/tool.js';
import { forgeKnowledgeTool } from '../../knowledge/tool.js';
import type { McpContext } from '../../lib/tool.js';
import { forgeMemoryTool } from '../../memory/tool.js';
import {
  forgeMetricsProjectStepDurationsTool,
  forgeMetricsProjectTimeseriesTool,
} from '../../metrics/tool.js';
import { forgeProjectPipelineRunsTool } from '../../pipeline/tool.js';
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
