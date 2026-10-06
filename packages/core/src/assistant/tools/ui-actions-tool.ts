// a UI action is a client-side tool: core validates the call against the closed registry and
// forwards it on the turn's own stream as a deferred result; the browser that sent the message executes
// it as the signed-in person and reports the page it produced on the next message's snapshot. Core never
// executes one, so a ui_* call can change no data whatever its params say.

import {
  parseUiAction,
  UI_ACTION_DEFERRED,
  UI_ACTION_NAMES,
  UI_ACTIONS,
  uiActionJsonSchema,
} from '@forge/contracts/ui-actions';
import type { ChatTool } from '../../integrations/llm/index.js';
import { type ChatToolset, toolError } from './mcp-adapter.js';

export function buildUiActionToolset(): ChatToolset {
  const tools: ChatTool[] = UI_ACTION_NAMES.map((name) => ({
    type: 'function',
    function: {
      name: UI_ACTIONS[name].wire,
      description: `${UI_ACTIONS[name].describe} Runs in the person's browser, changes only what they see, and never changes data.`,
      parameters: uiActionJsonSchema(name),
    },
  }));

  return {
    tools,
    async execute(name, argsJson) {
      let args: unknown;
      try {
        args = argsJson.trim() ? JSON.parse(argsJson) : {};
      } catch {
        return toolError(
          `UI_ACTION_INVALID: ${name} arguments were not valid JSON. Nothing was changed.`,
        );
      }
      const parsed = parseUiAction(name, args);
      if (!parsed.ok) return toolError(parsed.message);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              deferred: UI_ACTION_DEFERRED,
              action: parsed.action,
              note: "Handed to the person's browser, which applies it and shows it as a card with Undo; the next message carries the page it produced.",
            }),
          },
        ],
      };
    },
    ranAs: () => null,
  };
}
