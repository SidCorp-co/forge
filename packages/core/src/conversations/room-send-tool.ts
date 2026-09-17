/**
 * The one way a `tool`-mode turn reaches its room: a tool the model calls with
 * the text it wants posted (ISS-1087).
 *
 * It captures and never sends. The text it captures replaces the model's own
 * reply before the screen, and goes out through the same `deliver` every other
 * turn uses — so there is one delivery path, and a turn that never calls this
 * has said nothing, which the runner records by name.
 */

import type { ChatToolset } from '../assistant/tools/mcp-adapter.js';
import { toolError } from '../assistant/tools/mcp-adapter.js';

export const ROOM_SEND_TOOL_NAME = 'room_send';

export interface RoomSendCapture {
  toolset: ChatToolset;
  /** The text the model asked to post, or null when it never asked. */
  captured: () => string | null;
}

/**
 * Build the tool and the capture it writes into.
 */
// cm:guard ONE message per turn and the FIRST stands: a second call is refused naming the first, because a room turn delivers exactly one message under its delivery key and a later call that replaced the earlier would let the model revise what a watcher may already have been shown. An empty text is refused rather than captured as a send of nothing (ISS-1087 criteria 18-20).
export function roomSendCapture(): RoomSendCapture {
  let text: string | null = null;
  const toolset: ChatToolset = {
    tools: [
      {
        type: 'function',
        function: {
          name: ROOM_SEND_TOOL_NAME,
          description:
            'Post ONE message to this room. In this room nothing you write reaches anyone unless you call this tool with it; if the discussion needs nothing from you, do not call it and reply with anything. One call per turn; the first stands.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The message to post, in plain chat text.' },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
    ],
    execute: async (name, argsJson) => {
      if (name !== ROOM_SEND_TOOL_NAME) return toolError(`unknown tool "${name}"`);
      let args: { text?: unknown } = {};
      try {
        args = argsJson.trim() ? (JSON.parse(argsJson) as typeof args) : {};
      } catch {
        return toolError('arguments were not valid JSON');
      }
      const candidate = typeof args.text === 'string' ? args.text.trim() : '';
      if (!candidate) return toolError('room_send needs a non-empty `text`');
      if (text !== null)
        return toolError('room_send was already called this turn; the first message stands');
      text = candidate;
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'captured' }) }] };
    },
  };
  return { toolset, captured: () => text };
}
