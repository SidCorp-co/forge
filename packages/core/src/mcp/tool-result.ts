/**
 * Wrap a tool handler's return value into an MCP `CallToolResult` body.
 *
 * Content-block opt-in: a handler that returns `{ _mcpContent: [...] }` (e.g.
 * `forge_uploads` action=fetch returning a `type:'image'` block so the model
 * can SEE an attached screenshot via vision, not just read its metadata) has
 * those blocks surfaced as the result `content`; the remaining keys (if any)
 * still ride along as `structuredContent`. Every other tool falls through to
 * the JSON-text wrapper, unchanged — preserving backward compatibility.
 *
 * Kept in its own module (no DB / SDK imports) so it is cheap to unit test.
 */
type McpContentBlock = { type: string } & Record<string, unknown>;

export function toToolCallContent(result: unknown): {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
} {
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
    };
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
