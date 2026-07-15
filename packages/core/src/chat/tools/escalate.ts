/**
 * ISS-675 — the `escalate` tool offered to the fast RocketChat chat model.
 *
 * A local synthetic tool (not an MCP tool), so it composes via `mergeToolsets`
 * without going through the MCP allowlist machinery — RC-only, never exposed
 * to web/desktop chat (those never escalate to a room). `execute()` returns a
 * stub; the real work happens in `connection-manager.ts`, which inspects
 * `result.toolCalls` for this call and drives `startEscalation` — the model's
 * tool-call record is the signal, not this function's return value.
 */

import type { ChatToolset } from './mcp-adapter.js';

export const ESCALATE_TOOL_NAME = 'escalate';

export function buildEscalationToolset(): ChatToolset {
  return {
    tools: [
      {
        type: 'function',
        function: {
          name: ESCALATE_TOOL_NAME,
          description:
            'Escalate a question you cannot answer from project knowledge to a deeper research agent, which will investigate the repository and reply later in this room. Use ONLY after forge_knowledge (search/list/get) returned no relevant hit for a repo/mechanism/architecture/pipeline question — never as a substitute for investigating with your other tools first, and never because you merely feel unsure.',
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: "The question to research, in the user's own words.",
              },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
      },
    ],
    execute: async () => JSON.stringify({ status: 'escalation_queued' }),
  };
}
