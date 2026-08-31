/**
 * Carry the images that arrived with a chat turn into the issues the model
 * files during that same turn.
 *
 * Server-side injection, not a tool the model calls: the picture is the whole
 * report on a "look at this" message, and a model that must remember to attach
 * it forgets on the turn it matters. Wrapping the toolset also keeps the
 * existing `forge_issues` create path — validation, mime allowlist, size caps,
 * partial-failure reporting — as the single implementation.
 */

import type { TurnImage } from '../vision.js';
import type { ChatToolset } from './mcp-adapter.js';

const ISSUES_TOOL = 'forge_issues';

/** `forge_issues.data.attachments` accepts at most 10; the vision budget in
 *  `vision.ts` already bounds what a turn can be carrying. */
const MAX_ATTACHED = 10;

/**
 * Wrap `inner` so a `forge_issues` **create** in this turn is filed with the
 * turn's images attached. Every other call, and every turn with no images, is
 * passed through untouched.
 */
// cm:why base64-inline rather than the `forge_uploads` presigned PUT the tool description prefers: that warning is about a MODEL emitting bytes (they land in the transcript and in chat_logs.toolCalls, costing context every later turn). Here the bytes are injected server-side AFTER the model emitted its arguments — run-turn-core replays the model's own `tc.arguments`, never these — so the transcript cost is zero and a presigned round-trip would only add a ticket to something already in memory.
// cm:edge contract -> packages/core/src/chat/tools/guards.ts — `attachments` must stay in CHAT_TOLERATED_DATA_KEYS for this injection to survive the guard; moving it to CHAT_REFUSED_DATA_KEYS silently drops every image the bot files
export function withTurnImages(inner: ChatToolset, images: readonly TurnImage[]): ChatToolset {
  if (images.length === 0) return inner;
  const attachments = images.slice(0, MAX_ATTACHED).map((i) => ({
    name: i.name,
    mime: i.mime,
    dataBase64: i.dataBase64,
  }));
  return {
    tools: inner.tools,
    execute(name, argsJson) {
      if (name !== ISSUES_TOOL) return inner.execute(name, argsJson);
      let args: Record<string, unknown>;
      try {
        args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
      } catch {
        return inner.execute(name, argsJson);
      }
      if (args.action !== 'create') return inner.execute(name, argsJson);
      const data = (args.data ?? {}) as Record<string, unknown>;
      // cm:guard assign, never merge — the model has no bytes to contribute, so anything it put under `attachments` is invented, and merging would file a fabricated attachment alongside the real one
      data.attachments = attachments;
      args.data = data;
      return inner.execute(name, JSON.stringify(args));
    },
  };
}
