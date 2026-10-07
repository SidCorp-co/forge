import type { ChatToolset } from './mcp-adapter.js';
import { toolError } from './mcp-adapter.js';

export const AWAIT_REPLY_TOOL_NAME = 'await_reply';

export interface AwaitReplyCapture {
  toolset: ChatToolset;
  /** Whether the model called the tool in this attempt. */
  declared: () => boolean;
}

/**
 * The one way an agent's reply comes to wait on the person: the model says so by calling this tool
 * in the turn that writes the reply, and the reply is recorded with `awaits_reply`. "Waiting on you"
 * reads that record and never the reply's text, because no reading of prose can tell a question
 * the agent needs answered from one it answered, echoed or listed reasons under (ISS-277). One
 * capture serves one attempt; a retried attempt gets its own.
 */
export function awaitReplyCapture(): AwaitReplyCapture {
  let declared = false;
  const toolset: ChatToolset = {
    tools: [
      {
        type: 'function',
        function: {
          name: AWAIT_REPLY_TOOL_NAME,
          description:
            'Call this when the reply you are writing ends by asking the person something you need answered before you can go on: a confirmation, a choice between options, a missing fact. It marks your reply as waiting on their answer, so the conversation shows "Waiting on you" until they reply. Do NOT call it for a question you answer yourself, a question you quote, echo or record for someone else, or a list of reasons under a heading phrased as a question. It changes nothing in what you write; once per turn is enough.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      },
    ],
    execute: async (name, argsJson) => {
      if (name !== AWAIT_REPLY_TOOL_NAME) return toolError(`unknown tool "${name}"`);
      let parsed: unknown = {};
      try {
        parsed = argsJson.trim() ? JSON.parse(argsJson) : {};
      } catch {
        return toolError('arguments were not valid JSON');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return toolError('arguments were not a JSON object');
      if (Object.keys(parsed).length > 0)
        return toolError(`${AWAIT_REPLY_TOOL_NAME} takes no arguments; call it with {}`);
      declared = true;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'recorded',
              note: 'Your reply will be marked as waiting on the person. End it with the question you need answered.',
            }),
          },
        ],
      };
    },
    ranAs: () => null,
  };
  return { toolset, declared: () => declared };
}
