/**
 * Wrap a tool handler's return value into an MCP `CallToolResult` body, for the `/mcp` transport
 * and for provider-chat alike. Content-block opt-in: a handler that returns `{ _mcpContent: [...] }`
 * (e.g. `forge_uploads` action=fetch returning a `type:'image'` block so the model can SEE a
 * screenshot) has those blocks surfaced as `content`, the remaining keys as `structuredContent`;
 * every other tool falls through to the JSON-text wrapper. No runtime imports, so cheap to test.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type { CallToolResult };

type McpContentBlock = { type: string } & Record<string, unknown>;

// cm:why the cast is the one trust boundary for handler-supplied `_mcpContent`: the SDK server validates this value against CallToolResultSchema at the transport, provider-chat has no transport to do it, and typing the blocks loosely here keeps that validation in one place instead of a cast at every consumer
export function toToolCallContent(result: unknown): CallToolResult {
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
    } as CallToolResult;
  }
  const structured =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { value: result };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: structured,
  };
}
