// a UI action is a client-side tool: core validates the call against the closed registry and
// forwards it on the turn's own stream as a deferred result; the browser that sent the message executes
// it as the signed-in person and reports the page it produced on the next message's snapshot. Core never
// executes one, so a ui_* call can change no data whatever its params say.
//
// The board is a wireframe and no report stands behind it, so it holds no figure (REQ-32 BC-5): a
// draw or a revise whose text states one is refused here and never reaches the browser.

import {
  parseUiAction,
  UI_ACTION_DEFERRED,
  UI_ACTION_NAMES,
  UI_ACTIONS,
  type UiAction,
  uiActionJsonSchema,
} from '@forge/contracts/ui-actions';
import type { ChatTool } from '../../integrations/llm/index.js';
import { figuresIn } from '../../messaging/figure-exemptions.js';
import { type ChatToolset, toolError } from './mcp-adapter.js';

const TEXT_FIELDS = ['title', 'label', 'text', 'placeholder', 'items'] as const;

/** Every text a board shape, a patch's `set` or the document carries, with where it sits. */
function textsOf(at: string, fields: Record<string, unknown>): { at: string; text: string }[] {
  return TEXT_FIELDS.flatMap((field) => {
    const v = fields[field];
    if (typeof v === 'string') return [{ at: `${at}.${field}`, text: v }];
    if (Array.isArray(v)) {
      return v.flatMap((item, i) =>
        typeof item === 'string' ? [{ at: `${at}.${field}.${i}`, text: item }] : [],
      );
    }
    return [];
  });
}

/** What a board action would put on the board as text; nothing for any other action. */
function boardTexts(action: UiAction): { at: string; text: string }[] {
  if (action.name === 'ui.board.draw') {
    const { doc } = action.params;
    return [
      ...textsOf('doc', doc as Record<string, unknown>),
      ...doc.shapes.flatMap((shape, i) =>
        textsOf(`doc.shapes.${i}`, shape as Record<string, unknown>),
      ),
    ];
  }
  if (action.name === 'ui.board.revise') {
    return action.params.ops.flatMap((op, i) =>
      op.op === 'add'
        ? textsOf(`ops.${i}.shape`, op.shape as Record<string, unknown>)
        : op.op === 'update'
          ? textsOf(`ops.${i}.set`, op.set)
          : [],
    );
  }
  return [];
}

/**
 * The refusal of a board action whose text states a figure, naming each: a date, an id, a version
 * or an ordinal is not one (`messaging/figure-exemptions.ts`). Null where the board would hold none.
 */
export function boardFigureRefusal(action: UiAction): string | null {
  const found = boardTexts(action).flatMap(({ at, text }) =>
    figuresIn(text).map((f) => `${at} "${text}" states ${f.quote}`),
  );
  if (found.length === 0) return null;
  return `UI_ACTION_BOARD_FIGURE: ${action.name} refused — ${found.join('; ')}. The board is a wireframe with no report behind it, so it holds no figure, not even one the person typed (REQ-32 BC-5): draw a chart, table or key figures with forge_report and then forge_show over its run, or write the wireframe with placeholders such as "N open". Nothing was changed.`;
}

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
      const figures = boardFigureRefusal(parsed.action);
      if (figures) return toolError(figures);
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
