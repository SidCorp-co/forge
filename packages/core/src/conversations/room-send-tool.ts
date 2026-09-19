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
        const parsed: unknown = argsJson.trim() ? JSON.parse(argsJson) : {};
        if (parsed === null || typeof parsed !== 'object')
          return toolError('arguments were not a JSON object');
        args = parsed as typeof args;
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
