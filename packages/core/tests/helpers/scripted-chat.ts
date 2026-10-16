/**
 * A chat provider that answers from a script, for a test that mocks `integrations/llm/chat.js`:
 * each turn takes the next step — one tool call, or a line of text — and records what the model
 * was offered and sent. It imports nothing of the app, so a `vi.mock` factory may import it.
 */

import { randomUUID } from 'node:crypto';

export interface ScriptStep {
  tool?: { name: string; args: unknown };
  text?: string;
}

export const script: {
  steps: ScriptStep[];
  offered: string[][];
  sent: { role: string; content: unknown }[][];
} = { steps: [], offered: [], sent: [] };

export function resetScript(): void {
  script.steps = [];
  script.offered = [];
  script.sent = [];
}

interface ScriptedRequest {
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
}

export const scriptedOpenChat = async () => ({
  model: 'scripted',
  provider: {
    id: 'scripted',
    defaultModel: 'scripted',
    async *stream(req: ScriptedRequest) {
      script.sent.push(req.messages);
      script.offered.push((req.tools ?? []).map((t) => t.function.name));
      const next = script.steps.shift() ?? { text: 'Thanks, could you tell me more?' };
      if (next.tool) {
        yield {
          type: 'tool_call',
          id: `call-${randomUUID()}`,
          name: next.tool.name,
          arguments: JSON.stringify(next.tool.args),
        };
      } else {
        yield { type: 'chunk', text: next.text ?? '' };
      }
      yield { type: 'done' };
    },
  },
});
