/**
 * Wrap a tool handler's return value into an MCP `CallToolResult` body, for the `/mcp` transport
 * and for provider-chat alike. Content-block opt-in: a handler that returns `{ _mcpContent: [...] }`
 * (e.g. `forge_uploads` action=fetch returning a `type:'image'` block so the model can SEE a
 * screenshot) has those blocks surfaced as `content`, the remaining keys as `structuredContent`;
 * every other tool falls through to the JSON-text wrapper. A handler that returns
 * `{ _mcpIsError: true, ... }` has the result flagged `isError` with the key stripped, so a tool
 * that hands a refusal BACK as data (the `forge` CLI's exit code and stderr) still audits as one.
 * No runtime imports, so cheap to test.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type { CallToolResult };

type McpContentBlock = { type: string } & Record<string, unknown>;

function errorFlagOf(result: unknown): { flagged: boolean; rest: unknown } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { flagged: false, rest: result };
  }
  const { _mcpIsError, ...rest } = result as Record<string, unknown>;
  return { flagged: _mcpIsError === true, rest };
}

export function toToolCallContent(handlerValue: unknown): CallToolResult {
  const { flagged, rest: result } = errorFlagOf(handlerValue);
  const errorKey = flagged ? { isError: true } : {};
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as Record<string, unknown>)._mcpContent)
  ) {
    const { _mcpContent, ...rest } = result as { _mcpContent: McpContentBlock[] } & Record<
      string,
      unknown
    >;
    return {
      content: _mcpContent,
      ...(Object.keys(rest).length > 0 ? { structuredContent: rest } : {}),
      ...errorKey,
    } as CallToolResult;
  }
  const structured =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { value: result };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: structured,
    ...errorKey,
  };
}
