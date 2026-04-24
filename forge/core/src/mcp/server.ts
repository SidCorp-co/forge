import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pkg from '../../package.json' with { type: 'json' };
import type { Device } from '../auth/deviceToken.js';
import { forgeMemorySearchTool } from './tools/forge-memory.js';
import {
  forgeSkillsGetTool,
  forgeSkillsListTool,
  forgeSkillsRegisterTool,
} from './tools/forge-skills.js';
import { type McpTool, forgeVersionTool } from './tools/forge-version.js';

/**
 * Build an MCP server wired to the per-request authenticated device. Tool
 * factories receive the device to close over project-scope enforcement.
 *
 * Tools:
 *  - `forge_version` — no device needed (uptime/version).
 *  - `forge_memory.search` — wraps `runMemorySearch` (ISS-198).
 *  - `forge_skills.list` / `.get` / `.register` — wrap ISS-196 REST logic
 *    via the shared `skills/service.ts` helpers.
 */
export function createMcpServer(device: Device): Server {
  const tools: McpTool[] = [
    forgeVersionTool,
    forgeMemorySearchTool(device),
    forgeSkillsListTool(device),
    forgeSkillsGetTool(device),
    forgeSkillsRegisterTool(device),
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
