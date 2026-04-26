import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pkg from '../../package.json' with { type: 'json' };
import { forgeCommentsTool } from './tools/forge-comments.js';
import { forgeIssuesTool } from './tools/forge-issues.js';
import { forgeMemorySearchTool } from './tools/forge-memory.js';
import {
  forgeSkillsGetTool,
  forgeSkillsListTool,
  forgeSkillsRegisterTool,
} from './tools/forge-skills.js';
import { type McpTool, forgeVersionTool } from './tools/forge-version.js';
import type { McpContext } from './tools/lib.js';

/**
 * Build an MCP server wired to the per-request {@link McpContext}. Tool
 * factories receive the device (and optional project slug) so handlers can
 * enforce project-scope access.
 *
 * Tools:
 *  - `forge_version` — no context needed (uptime/version).
 *  - `forge_memory.search` — wraps `runMemorySearch` (ISS-198).
 *  - `forge_skills.list` / `.get` / `.register` — wrap ISS-196 REST logic.
 *  - `forge_issues` / `forge_comments` — action-based parity with the legacy
 *    Strapi MCP so existing `/forge-*` skills work unchanged (ISS-293).
 */
export function createMcpServer(ctx: McpContext): Server {
  const { device } = ctx;
  const tools: McpTool[] = [
    forgeVersionTool,
    forgeMemorySearchTool(device),
    forgeSkillsListTool(device),
    forgeSkillsGetTool(device),
    forgeSkillsRegisterTool(device),
    forgeIssuesTool(ctx),
    forgeCommentsTool(ctx),
  ];
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: '@forge/core', version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler((args ?? {}) as Record<string, unknown>);
      const structured =
        result && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { value: result };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: structured,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
