import { forgeChannelTool } from '../../ecosystem/tool.js';
import { forgeKnowledgeTool } from '../../knowledge/tool.js';
import type { McpContext } from '../../lib/tool.js';
import { forgeMemoryTool } from '../../memory/tool.js';
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
  { factory: forgePreferencesTool },
  { factory: forgeMemoryNoteTool },
  { factory: forgeChannelTool },
];

let providedSpecs: readonly ChatToolSpec[] | null = null;

/**
 * Tools of modules this one may not import (a read model in a later context) join the allowlist
 * through the composition root, which provides them from the MCP registry at boot.
 */
export function provideChatTools(specs: readonly ChatToolSpec[]): void {
  providedSpecs = specs;
}

/** The whole allowlist: this module's own tools, then the provided ones. */
export function chatToolSpecs(): ChatToolSpec[] {
  if (!providedSpecs) {
    throw new Error(
      'chat toolset: the composed tools were not provided, so the allowlist is incomplete; the process entry calls provideChatTools(CHAT_READ_MODEL_TOOLS) from mcp/index.ts before it serves',
    );
  }
  return [...CHAT_TOOL_ALLOWLIST, ...providedSpecs];
}

/** Build the OpenAI toolset for a project-scoped chat context. */
export function buildProjectToolset(ctx: McpContext): ChatToolset {
  return buildToolset(ctx, chatToolSpecs());
}
