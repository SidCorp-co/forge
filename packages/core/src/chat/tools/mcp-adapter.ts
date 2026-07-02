/**
 * ISS-604 — adapt the `forge_*` MCP tool catalog to OpenAI `tools[]` for
 * provider-chat, and execute tool calls by dispatching back to the MCP
 * handler. One catalog, two front-ends (MCP transport + provider-chat).
 *
 * The adapter is thin because an MCP tool is already
 * `(ctx) => { name, description, inputSchema (JSON Schema), handler }` — the
 * inputSchema drops straight into `function.parameters` and the handler runs
 * on a parsed args object. Two transforms are applied:
 *   1. name sanitize — OpenAI function names must match `[A-Za-z0-9_-]{1,64}`,
 *      but MCP names contain dots (`forge_projects.get`). Map `.`→`_` and keep
 *      a reverse lookup for dispatch.
 *   2. read-only action gate — multi-action tools (`forge_issues`, …) can also
 *      write; a spec's `readActions` allowlist rejects any other `action`.
 */

import type { ContextScopedMcpToolFactory, McpContext } from '../../mcp/tools/lib.js';
import type { ChatTool } from '../providers/types.js';

/** One entry in the chat tool allowlist. */
export interface ChatToolSpec {
  factory: ContextScopedMcpToolFactory;
  /**
   * When set, the tool dispatches on an `action` arg and only these values are
   * permitted (read-only gate). Omit for tools that are inherently read-only.
   */
  readActions?: string[];
}

export interface ChatToolset {
  /** OpenAI `tools[]` to offer the model. */
  tools: ChatTool[];
  /** Execute a tool call by (sanitized) name; returns the result as a string. */
  execute(name: string, argsJson: string): Promise<string>;
}

/** OpenAI function names: `[A-Za-z0-9_-]{1,64}`. MCP names may contain dots. */
function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

const DESCRIPTION_CAP = 1024;
const RESULT_CAP = 24_000;

function truncate(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}… [truncated]` : s;
}

/**
 * Build the toolset for a project-scoped context. Instantiates each allowed
 * factory once, converts to OpenAI tools, and closes over a dispatch map.
 */
export function buildToolset(ctx: McpContext, specs: ChatToolSpec[]): ChatToolset {
  const tools: ChatTool[] = [];
  const bySanitized = new Map<
    string,
    { spec: ChatToolSpec; handler: (a: Record<string, unknown>) => Promise<unknown> }
  >();

  for (const spec of specs) {
    const tool = spec.factory(ctx);
    const name = sanitizeName(tool.name);
    if (bySanitized.has(name)) continue; // defensive: skip a name collision
    bySanitized.set(name, { spec, handler: tool.handler });
    const readNote = spec.readActions
      ? ` (chat is read-only: only actions ${spec.readActions.join('/')} are permitted)`
      : '';
    tools.push({
      type: 'function',
      function: {
        name,
        description: truncate(tool.description + readNote, DESCRIPTION_CAP),
        parameters: tool.inputSchema,
      },
    });
  }

  async function execute(name: string, argsJson: string): Promise<string> {
    const entry = bySanitized.get(name);
    if (!entry) return JSON.stringify({ error: `unknown tool "${name}"` });

    let args: Record<string, unknown>;
    try {
      args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ error: 'arguments were not valid JSON' });
    }

    if (entry.spec.readActions) {
      const action = args.action;
      if (typeof action !== 'string' || !entry.spec.readActions.includes(action)) {
        return JSON.stringify({
          error: `action "${String(action)}" is not permitted in chat (read-only). Allowed: ${entry.spec.readActions.join(', ')}`,
        });
      }
    }

    try {
      const result = await entry.handler(args);
      return truncate(JSON.stringify(result ?? null), RESULT_CAP);
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { tools, execute };
}
