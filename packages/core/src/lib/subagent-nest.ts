// A subagent's lines under the `Agent` call that spawned it (ISS-1268). Claude Code marks each line
// a subagent writes with `parent_tool_use_id`, the id of that call (`--forward-subagent-text` adds
// its text and thinking); the fold puts what the subagent said and called into the call's
// `subagent` blocks instead of beside the session's own reply, and settles its tool calls there.

import type { AgentMessage, ContentBlock, ToolCall } from './agent-stream-parser.js';

/** `call` with what `line` adds to its subagent: its blocks, or one of its calls settled. */
function addTo(call: ToolCall, line: AgentMessage): ToolCall {
  const blocks = call.subagent ?? [];
  if (line.type === 'assistant') {
    const known = new Set(blocks.flatMap((b) => (b.toolCall ? [b.toolCall.id] : [])));
    const added = (line.blocks ?? []).filter((b) => !(b.toolCall && known.has(b.toolCall.id)));
    return { ...call, subagent: [...blocks, ...added] };
  }
  const settled = (t: ToolCall): ToolCall => ({
    ...t,
    output: line.toolOutput,
    ...(line.isError === true ? { isError: true } : {}),
    ...(line.durationMs !== undefined ? { durationMs: line.durationMs } : {}),
  });
  return { ...call, subagent: blocks.map((b) => onCall(b, line.toolName ?? '', settled)) };
}

/** `block` with the call `id` in it, or in a subagent under it, replaced by `change(call)`. */
function onCall(block: ContentBlock, id: string, change: (t: ToolCall) => ToolCall): ContentBlock {
  const call = block.toolCall;
  if (!call) return block;
  if (call.id === id) return { ...block, toolCall: change(call) };
  if (!call.subagent) return block;
  return {
    ...block,
    toolCall: { ...call, subagent: call.subagent.map((b) => onCall(b, id, change)) },
  };
}

/** Whether `blocks` hold the call `id`, at any depth. */
function holds(blocks: readonly ContentBlock[] | undefined, id: string): boolean {
  return (blocks ?? []).some(
    (b) => b.toolCall !== undefined && (b.toolCall.id === id || holds(b.toolCall.subagent, id)),
  );
}

/**
 * Fold a subagent's `line` into the call `parentId` names, in the latest message holding it; false
 * where no message holds that call, and the line is kept as the session's own so nothing it said is
 * lost. Only the assistant's blocks and its tools' results nest; nothing else a subagent writes is
 * shown.
 */
export function nestUnder(messages: AgentMessage[], parentId: string, line: AgentMessage): boolean {
  if (line.type !== 'assistant' && line.type !== 'tool_result') return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AgentMessage;
    if (m.type !== 'assistant' || !holds(m.blocks, parentId)) continue;
    const change = (t: ToolCall) => addTo(t, line);
    const blocks = (m.blocks ?? []).map((b) => onCall(b, parentId, change));
    const top = blocks.flatMap((b) => (b.type === 'tool' && b.toolCall ? [b.toolCall] : []));
    const byId = new Map(top.map((t) => [t.id, t]));
    messages[i] = {
      ...m,
      blocks,
      ...(m.toolCalls ? { toolCalls: m.toolCalls.map((t) => byId.get(t.id) ?? t) } : {}),
    };
    return true;
  }
  return false;
}
