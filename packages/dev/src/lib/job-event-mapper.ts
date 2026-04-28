import type { JobEventInput } from "@/lib/api";

// Translate a single Claude CLI stream chunk (as emitted via Tauri's
// `agent:message` event) into one or more JobEventInputs for packages/core's
// /api/jobs/:id/events endpoint. Mirrors the parser in stream-parser.ts but
// preserves the raw payload — analytics/UI on the core side can re-derive
// rendering details if needed.
export function mapStreamChunkToJobEvents(chunk: unknown): JobEventInput[] {
  if (!chunk || typeof chunk !== "object") return [];
  const data = chunk as Record<string, unknown>;
  const type = data.type as string | undefined;

  if (type === "assistant") {
    const msg = data.message as Record<string, unknown> | undefined;
    const content = (msg?.content as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }> | undefined) ?? [];
    const events: JobEventInput[] = [];
    for (const c of content) {
      if (c.type === "text" && c.text) {
        events.push({ kind: "stdout", data: { text: c.text } });
      } else if (c.type === "tool_use") {
        events.push({
          kind: "tool_call",
          data: { id: c.id, name: c.name, input: c.input },
        });
      }
    }
    return events;
  }

  if (type === "user") {
    const msg = data.message as Record<string, unknown> | undefined;
    const content = (msg?.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> | undefined) ?? [];
    return content
      .filter((c) => c.type === "tool_result")
      .map<JobEventInput>((r) => ({
        kind: r.is_error ? "stderr" : "tool_result",
        data: { tool_use_id: r.tool_use_id, content: r.content, is_error: !!r.is_error },
      }));
  }

  if (type === "result") {
    return [{ kind: "result", data }];
  }

  if (type === "system") {
    return [{ kind: "progress", data }];
  }

  return [{ kind: "progress", data }];
}
