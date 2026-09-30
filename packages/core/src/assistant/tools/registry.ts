import { forgeGuideTool } from '../../mcp/tools/forge-guide.js';
import { forgeKnowledgeTool } from '../../mcp/tools/forge-knowledge.js';
import { forgeMemorySearchTool } from '../../mcp/tools/forge-memory.js';
import {
  forgeMetricsProjectStepDurationsTool,
  forgeMetricsProjectTimeseriesTool,
} from '../../mcp/tools/forge-metrics.js';
import { forgePipelineRunsGetTool } from '../../mcp/tools/forge-pipeline-runs.js';
import { forgeProjectPipelineRunsTool } from '../../mcp/tools/forge-project-pipeline-runs.js';
import { forgeProjectsGetTool } from '../../mcp/tools/forge-projects.js';
import type { McpContext } from '../../mcp/tools/lib.js';
import { forgeCliTool } from './forge-cli-tool.js';
import { forgeMemoryNoteTool } from './forge-memory-note-tool.js';
import { forgePreferencesTool } from './forge-preferences-tool.js';
import { buildToolset, type ChatToolSpec, type ChatToolset } from './mcp-adapter.js';

/** Curated allowlist exposed to the chat model. */
export const CHAT_TOOL_ALLOWLIST: ChatToolSpec[] = [
  { factory: forgeCliTool, grant: null },
  { factory: forgeGuideTool, grant: null, allowedActions: ['list', 'get'] },
  {
    factory: forgeKnowledgeTool,
    grant: 'knowledge:read',
    allowedActions: ['list', 'get', 'search'],
  },
  { factory: forgeMemorySearchTool, grant: 'knowledge:read' },
  { factory: forgeProjectsGetTool, grant: 'projects:read' },
  { factory: forgePipelineRunsGetTool, grant: 'pipeline:read' },
  { factory: forgeProjectPipelineRunsTool, grant: 'pipeline:read' },
  { factory: forgeMetricsProjectStepDurationsTool, grant: 'pipeline:read' },
  { factory: forgeMetricsProjectTimeseriesTool, grant: 'projects:read' },
  { factory: forgePreferencesTool, grant: 'account:write' },
  { factory: forgeMemoryNoteTool, grant: 'knowledge:write' },
];

/** Build the OpenAI toolset for a project-scoped chat context. */
export function buildProjectToolset(ctx: McpContext): ChatToolset {
  return buildToolset(ctx, CHAT_TOOL_ALLOWLIST);
}
