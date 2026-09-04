/**
 * ISS-675 — the `escalate` tool offered to the fast RocketChat chat model. A local synthetic tool,
 * RC-only, never exposed to web chat. `execute()` returns a stub: `connection-manager.ts` inspects
 * `result.toolCalls` for this call and drives `startEscalation` — the record is the signal.
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
    execute: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ status: 'escalation_queued' }) }],
    }),
  };
}
