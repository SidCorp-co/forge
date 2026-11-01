/**
 * ISS-675 — the `escalate` tool offered to the fast RocketChat chat model. A local synthetic tool,
 * RC-only, never exposed to web chat. `execute()` returns a stub: `connection-manager.ts` inspects
 * `result.toolCalls` for this call and drives `startEscalation` — the record is the signal.
 */

import { ESCALATE_TOOL_NAME } from '@forge/contracts/assistant';
import type { ChatToolset } from './mcp-adapter.js';

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
      // the fact, never a line: the turn's own words are what the room hears, or nothing (ISS-857)
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'escalation_queued',
            note: 'A research agent now investigates this; its answer is posted in this thread when it is ready. If the person should hear that now, tell them in your own words, in their language, without a time.',
          }),
        },
      ],
    }),
    ranAs: () => null,
  };
}
