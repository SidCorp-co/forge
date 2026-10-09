/**
 * A tool's output as a thread stores it, read back as text. Core's own assistant stores the result
 * body as plain JSON; a tool reached over MCP stores a `content` envelope. Every reader of a tool
 * result in a turn goes through this one function, so a block that reads one shape and drops the
 * other cannot come back (REQ-41 BC-14: the idea offer drew no button).
 */
export function toolOutputText(output: unknown): string {
  if (typeof output !== "string") return JSON.stringify(output ?? "");
  try {
    const parsed: unknown = JSON.parse(output);
    const content = (parsed as { content?: { type: string; text?: string }[] } | null)?.content;
    if (Array.isArray(content)) return content.map((b) => b.text ?? "").join("\n");
  } catch {
    // a plain text result, read as is
  }
  return output;
}
