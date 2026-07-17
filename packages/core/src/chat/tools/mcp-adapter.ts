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
 *   2. action gate — multi-action tools (`forge_issues`, …) expose more actions
 *      than chat should reach; a spec's `allowedActions` allowlist rejects any
 *      other `action`, and an optional `guard` vets/normalizes the args of the
 *      permitted ones (e.g. force bot-created issues to status `draft`).
 */

import type { ContextScopedMcpToolFactory, McpContext } from '../../mcp/tools/lib.js';
import type { ChatTool } from '../providers/types.js';

/** One entry in the chat tool allowlist. */
export interface ChatToolSpec {
  factory: ContextScopedMcpToolFactory;
  /**
   * When set, the tool dispatches on an `action` arg and only these values are
   * permitted. Omit for tools that are inherently single-action/read-only.
   */
  allowedActions?: string[];
  /**
   * Vet/normalize args before dispatch (runs after the action gate; may mutate
   * `args` in place). Return an error string to reject the call, null to
   * allow. `ctx.projectId` is the session-bound project (resolved BEFORE it's
   * pinned onto `args`, e.g. for a DB-backed check like the create-path dedup
   * guard); may be async.
   */
  guard?: (
    args: Record<string, unknown>,
    ctx?: { projectId: string | null },
  ) => string | null | Promise<string | null>;
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
 * Return a shallow clone of a JSON-Schema object with `key` removed from both
 * `properties` and `required`. Used to hide the server-pinned `projectId` from
 * the model so it never asks for or guesses it.
 */
function stripProperty(schema: Record<string, unknown>, key: string): Record<string, unknown> {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props || !(key in props)) return schema;
  const { [key]: _drop, ...rest } = props;
  const out: Record<string, unknown> = { ...schema, properties: rest };
  if (Array.isArray(schema.required)) {
    out.required = (schema.required as unknown[]).filter((r) => r !== key);
  }
  return out;
}

/**
 * Build the toolset for a project-scoped context. Instantiates each allowed
 * factory once, converts to OpenAI tools, and closes over a dispatch map.
 */
export function buildToolset(ctx: McpContext, specs: ChatToolSpec[]): ChatToolset {
  const tools: ChatTool[] = [];
  // The session is fenced to one project; force every tool's projectId to it so
  // the model never has to guess a UUID (and can't address another project).
  const boundProjectId = ctx.boundProjectId ?? null;
  const bySanitized = new Map<
    string,
    {
      spec: ChatToolSpec;
      handler: (a: Record<string, unknown>) => Promise<unknown>;
      hasProjectId: boolean;
    }
  >();

  for (const spec of specs) {
    const tool = spec.factory(ctx);
    const name = sanitizeName(tool.name);
    if (bySanitized.has(name)) continue; // defensive: skip a name collision
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
    const hasProjectId = !!props && 'projectId' in props;
    const willInject = hasProjectId && boundProjectId !== null;
    bySanitized.set(name, { spec, handler: tool.handler, hasProjectId });
    const readNote = spec.allowedActions
      ? ` (in chat only actions ${spec.allowedActions.join('/')} are permitted)`
      : '';
    // When we pin projectId server-side, hide it from the model so it neither
    // asks for nor invents one.
    const parameters = willInject ? stripProperty(tool.inputSchema, 'projectId') : tool.inputSchema;
    tools.push({
      type: 'function',
      function: {
        name,
        description: truncate(tool.description + readNote, DESCRIPTION_CAP),
        parameters,
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

    if (entry.spec.allowedActions) {
      const action = args.action;
      if (typeof action !== 'string' || !entry.spec.allowedActions.includes(action)) {
        return JSON.stringify({
          error: `action "${String(action)}" is not permitted in chat. Allowed: ${entry.spec.allowedActions.join(', ')}`,
        });
      }
    }

    if (entry.spec.guard) {
      const rejection = await entry.spec.guard(args, { projectId: boundProjectId });
      if (rejection) return JSON.stringify({ error: rejection });
    }

    // Pin the project to the session's — ignore whatever the model supplied.
    if (entry.hasProjectId && boundProjectId) {
      args.projectId = boundProjectId;
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

/**
 * Compose several toolsets into one (e.g. the forge_* MCP set + RC-scoped room
 * tools). Dispatch routes by tool name, first toolset owning a name wins.
 */
export function mergeToolsets(...sets: ChatToolset[]): ChatToolset {
  const owner = new Map<string, ChatToolset>();
  const tools: ChatTool[] = [];
  for (const set of sets) {
    for (const tool of set.tools) {
      if (owner.has(tool.function.name)) continue;
      owner.set(tool.function.name, set);
      tools.push(tool);
    }
  }
  return {
    tools,
    execute(name, argsJson) {
      const set = owner.get(name);
      if (!set) return Promise.resolve(JSON.stringify({ error: `unknown tool "${name}"` }));
      return set.execute(name, argsJson);
    },
  };
}
