/**
 * ISS-609 follow-up — bridge the project's CONFIGURED external MCP servers
 * (`pipelineConfig.mcpServers`, e.g. a task hub) into the provider-chat
 * toolset, so the RC bot investigates the same systems the pipeline agents
 * get injected.
 *
 * Per turn: connect each http server with the stored headers, list its tools,
 * adapt to OpenAI `tools[]` (names prefixed with the server key so hub/forge
 * names can't collide), and proxy execute → `tools/call`. Everything is
 * best-effort — a dead server logs and contributes no tools; it never breaks
 * the turn. Callers MUST `dispose()` after the turn to close the clients.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from '../../logger.js';
import type { ChatTool } from '../providers/types.js';
import type { ChatToolset } from './mcp-adapter.js';

export interface ExternalMcpServerConfig {
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  /** Operator-written usage guidance appended to every bridged tool's
   *  description (e.g. which GraphQL queries answer common questions) —
   *  smaller models need the map, not just the raw schema. */
  notes?: string;
}

const CONNECT_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 20_000;
const MAX_SERVERS = 4;
const MAX_TOOLS_PER_SERVER = 40;
const DESCRIPTION_CAP = 1024;
const RESULT_CAP = 24_000;

function truncate(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}… [truncated]` : s;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Extract the http MCP servers from a project's agentConfig, best-effort. */
export function readProjectMcpServers(
  agentConfig: unknown,
): Array<{ key: string; config: ExternalMcpServerConfig }> {
  if (!agentConfig || typeof agentConfig !== 'object') return [];
  const pipelineConfig = (agentConfig as Record<string, unknown>).pipelineConfig;
  if (!pipelineConfig || typeof pipelineConfig !== 'object') return [];
  const servers = (pipelineConfig as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const out: Array<{ key: string; config: ExternalMcpServerConfig }> = [];
  for (const [key, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue; // boolean entries toggle builtin servers
    const cfg = raw as ExternalMcpServerConfig;
    if (typeof cfg.url !== 'string' || !/^https?:\/\//.test(cfg.url)) continue;
    if (cfg.type !== undefined && cfg.type !== 'http') continue;
    out.push({ key, config: cfg });
    if (out.length >= MAX_SERVERS) break;
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Serialize a tools/call result to the string the chat model receives. */
function serializeCallResult(result: unknown): string {
  const content = (result as { content?: unknown[] })?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const p = part as { type?: string; text?: string };
        return p?.type === 'text' && typeof p.text === 'string' ? p.text : JSON.stringify(part);
      })
      .join('\n');
    return truncate(text, RESULT_CAP);
  }
  return truncate(JSON.stringify(result ?? null), RESULT_CAP);
}

export interface ExternalMcpToolsets {
  toolsets: ChatToolset[];
  /** Close every connected client — call in a finally after the turn. */
  dispose(): Promise<void>;
}

/**
 * Connect the project's configured external MCP servers and adapt their tools.
 * Tool names are exposed as `<serverKey>__<toolName>` (sanitized, 64-char cap).
 */
export async function buildExternalMcpToolsets(agentConfig: unknown): Promise<ExternalMcpToolsets> {
  const servers = readProjectMcpServers(agentConfig);
  const toolsets: ChatToolset[] = [];
  const clients: Client[] = [];

  for (const { key, config } of servers) {
    try {
      const client = new Client({ name: 'forge-chat-bridge', version: '1.0.0' });
      // Cast: the SDK's own transport type mismatches its Client under
      // `exactOptionalPropertyTypes` (upstream typing gap, not a real issue).
      const transport = new StreamableHTTPClientTransport(new URL(config.url as string), {
        requestInit: { headers: config.headers ?? {} },
      }) as unknown as Transport;
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `mcp ${key} connect`);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `mcp ${key} list`);
      clients.push(client);

      const prefix = sanitize(key);
      const notes =
        typeof config.notes === 'string' && config.notes.trim().length > 0
          ? ` Usage notes: ${config.notes.trim()}`
          : '';
      const byName = new Map<string, string>(); // exposed name → real tool name
      const tools: ChatTool[] = [];
      for (const tool of listed.tools.slice(0, MAX_TOOLS_PER_SERVER)) {
        const exposed = `${prefix}__${sanitize(tool.name)}`.slice(0, 64);
        if (byName.has(exposed)) continue;
        byName.set(exposed, tool.name);
        tools.push({
          type: 'function',
          function: {
            name: exposed,
            description: truncate(
              `[${key}] ${tool.description ?? tool.name}${notes}`,
              DESCRIPTION_CAP,
            ),
            parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object' },
          },
        });
      }

      toolsets.push({
        tools,
        async execute(name, argsJson) {
          const real = byName.get(name);
          if (!real) return JSON.stringify({ error: `unknown tool "${name}"` });
          let args: Record<string, unknown>;
          try {
            args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
          } catch {
            return JSON.stringify({ error: 'arguments were not valid JSON' });
          }
          try {
            const result = await withTimeout(
              client.callTool({ name: real, arguments: args }),
              CALL_TIMEOUT_MS,
              `mcp ${key} call ${real}`,
            );
            return serializeCallResult(result);
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      });
      logger.info({ server: key, tools: tools.length }, 'chat: external MCP server bridged');
    } catch (err) {
      logger.warn({ err, server: key }, 'chat: external MCP server unavailable; skipping');
    }
  }

  return {
    toolsets,
    async dispose() {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
