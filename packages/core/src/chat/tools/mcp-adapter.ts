/**
 * ISS-604 — adapt the `forge_*` MCP tool catalog to OpenAI `tools[]` for provider-chat and dispatch
 * calls back to the MCP handler: one catalog, two front-ends. An MCP tool is already
 * `{ name, description, inputSchema, handler }`, so the adapter only sanitizes names (OpenAI allows
 * `[A-Za-z0-9_-]{1,64}`, MCP names carry dots) and gates multi-action tools through a spec's
 * `allowedActions` allowlist plus an optional arg `guard`.
 */

import { type CallToolResult, toToolCallContent } from '../../mcp/tool-result.js';
import type { ContextScopedMcpToolFactory, McpContext } from '../../mcp/tools/lib.js';
import type { ChatTool } from '../providers/types.js';

/** One entry in the chat tool allowlist. */
export interface ChatToolSpec {
  factory: ContextScopedMcpToolFactory;
  /** Permitted `action` values; omit for single-action tools. */
  allowedActions?: string[];
  describe?: string;
  /** Runs after the action gate, may mutate `args`; an error string rejects, null allows. `ctx.projectId` is the session-bound project, resolved BEFORE it is pinned onto `args`. */
  guard?: (
    args: Record<string, unknown>,
    ctx?: { projectId: string | null },
  ) => string | null | Promise<string | null>;
}

export interface ChatToolset {
  /** OpenAI `tools[]` to offer the model. */
  tools: ChatTool[];
  /** Execute a tool call by (sanitized) name. The result is MCP's own `CallToolResult` — content blocks plus `isError` — so an external server's reply passes through untouched and an internal handler's is wrapped by the same `toToolCallContent` the `/mcp` transport uses; `toolResultText` flattens it for the model. */
  execute(name: string, argsJson: string): Promise<CallToolResult>;
}

/** OpenAI function names: `[A-Za-z0-9_-]{1,64}`. MCP names may contain dots. */
function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

export const DESCRIPTION_CAP = 1024;
export const RESULT_CAP = 24_000;

export function truncate(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}… [truncated]` : s;
}

/** The one error shape every toolset returns — a JSON `{error}` text block, which is what the model read before results carried `isError`, plus the flag the audit record needs. */
export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

// cm:why a Drizzle query error's `message` is the SQL plus params and its `cause` is the Postgres reason — the model was shown 500 chars of INSERT and never "duplicate key" (measured 2026-09-04), so the cause wins when there is one
export function thrownMessage(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return err instanceof Error ? err.message : String(err);
}

/** Flatten a result to the string the model reads as its `role:'tool'` message: text blocks joined, any other block (image, resource) JSON-serialised, capped at RESULT_CAP. */
export function toolResultText(result: CallToolResult): string {
  const text = result.content
    .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
    .join('\n');
  return truncate(text, RESULT_CAP);
}

// cm:guard top-level keys the tool's OWN schema does not declare are dropped before the handler parses — models decorate calls (Gemini sends `reason` on a tool whose only parameter, projectId, was stripped from the advertised copy; measured 2026-09-04) and every forge_* input schema is `.strict()`, so an undeclared key is a whole-call rejection for a tool the model called correctly; judged against the declared schema, not the advertised one, so the pinned projectId is never a casualty, and skipped when the schema declares no properties or opts into additionalProperties
function dropUndeclaredKeys(args: Record<string, unknown>, schema: Record<string, unknown>): void {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props || Object.keys(props).length === 0 || schema.additionalProperties === true) return;
  for (const key of Object.keys(args)) {
    if (!(key in props)) delete args[key];
  }
}

/** Shallow clone with `key` removed from `properties` and `required` — hides the server-pinned `projectId` so the model never guesses one. */
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

/** Instantiate each allowed factory once, convert to OpenAI tools, close over a dispatch map. */
export function buildToolset(ctx: McpContext, specs: ChatToolSpec[]): ChatToolset {
  const tools: ChatTool[] = [];
  // cm:guard every tool's projectId is forced to the session's bound project and stripped from the advertised schema — a tool that honoured the model-supplied one would let a chat session read or write another project
  const boundProjectId = ctx.boundProjectId ?? null;
  const bySanitized = new Map<
    string,
    {
      spec: ChatToolSpec;
      handler: (a: Record<string, unknown>) => Promise<unknown>;
      hasProjectId: boolean;
      declared: Record<string, unknown>;
    }
  >();

  for (const spec of specs) {
    const tool = spec.factory(ctx);
    const name = sanitizeName(tool.name);
    if (bySanitized.has(name)) continue; // defensive: skip a name collision
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
    const hasProjectId = !!props && 'projectId' in props;
    const willInject = hasProjectId && boundProjectId !== null;
    const parameters = willInject ? stripProperty(tool.inputSchema, 'projectId') : tool.inputSchema;
    bySanitized.set(name, {
      spec,
      handler: tool.handler,
      hasProjectId,
      declared: tool.inputSchema,
    });
    const readNote = spec.allowedActions
      ? ` (in chat only actions ${spec.allowedActions.join('/')} are permitted)`
      : '';
    tools.push({
      type: 'function',
      function: {
        name,
        description: truncate(
          tool.description + readNote + (spec.describe ? ` ${spec.describe}` : ''),
          DESCRIPTION_CAP,
        ),
        parameters,
      },
    });
  }

  async function execute(name: string, argsJson: string): Promise<CallToolResult> {
    const entry = bySanitized.get(name);
    if (!entry) return toolError(`unknown tool "${name}"`);

    let args: Record<string, unknown>;
    try {
      args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch {
      return toolError('arguments were not valid JSON');
    }

    dropUndeclaredKeys(args, entry.declared);
    if (entry.spec.allowedActions) {
      const action = args.action;
      if (typeof action !== 'string' || !entry.spec.allowedActions.includes(action)) {
        return toolError(
          `action "${String(action)}" is not permitted in chat. Allowed: ${entry.spec.allowedActions.join(', ')}`,
        );
      }
    }

    if (entry.spec.guard) {
      const rejection = await entry.spec.guard(args, { projectId: boundProjectId });
      if (rejection) return toolError(rejection);
    }

    if (entry.hasProjectId && boundProjectId) {
      args.projectId = boundProjectId;
    }

    try {
      return toToolCallContent(await entry.handler(args));
    } catch (err) {
      return toolError(thrownMessage(err));
    }
  }

  return { tools, execute };
}

/** Compose toolsets; dispatch routes by tool name, the first owner of a name wins. */
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
    async execute(name, argsJson) {
      const set = owner.get(name);
      return set ? set.execute(name, argsJson) : toolError(`unknown tool "${name}"`);
    },
  };
}
