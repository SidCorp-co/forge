// a UI action is a client-side tool: core validates the call against the closed registry and
// forwards it on the turn's own stream as a deferred result; the browser that sent the message executes
// it as the signed-in person and reports the page it produced on the next message's snapshot. Core never
// executes one, so a ui_* call can change no data whatever its params say.
//
// The board is a wireframe and no report stands behind it, so it holds no figure (REQ-32 BC-5): a
// draw or a revise whose text states one is refused here and never reaches the browser. A highlight
// is judged against the page the person sent with their message, as this turn's earlier actions
// leave it (REQ-41 BC-6): one the page cannot show is refused here, before the browser is asked.

import {
  highlightRefusal,
  parseUiAction,
  UI_ACTION_DEFERRED,
  UI_ACTION_NAMES,
  UI_ACTIONS,
  UI_LIST_FILTER_ACTIONS,
  UI_PAGE_ITEM_KINDS,
  type UiAction,
  type UiPageItemKind,
  type UiSnapshot,
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

/** The page as the turn's actions leave it; `shownUnknown` once one moved it to a list it has not reported. */
type ProjectedPage = { snapshot: UiSnapshot; shownUnknown: boolean };

const isPageItemKind = (kind: string): kind is UiPageItemKind =>
  (UI_PAGE_ITEM_KINDS as readonly string[]).includes(kind);

/** The page one applied action leaves: a move drops the record and the rows the held snapshot named. */
export function pageAfter(page: ProjectedPage, action: UiAction): ProjectedPage {
  const { v, path, board } = page.snapshot;
  const base = { v, path, ...(board ? { board } : {}) };
  switch (action.name) {
    case 'ui.navigate':
      return { snapshot: { ...base, route: action.params.route }, shownUnknown: true };
    case 'ui.issues.filter':
    case 'ui.requirements.filter':
    case 'ui.feedback.filter':
    case 'ui.workflows.filter':
    case 'ui.releases.filter':
      return {
        snapshot: { ...base, route: action.name.split('.')[1] as UiSnapshot['route'] },
        shownUnknown: true,
      };
    case 'ui.open': {
      const { kind, key } = action.params;
      if (!isPageItemKind(kind))
        return { snapshot: { ...base, route: 'releases' }, shownUnknown: false };
      return {
        snapshot: { ...base, route: kind, item: { kind, key } as UiSnapshot['item'] & object },
        shownUnknown: false,
      };
    }
    default:
      return page;
  }
}

/**
 * Why a highlight cannot land on the page, or null where it can or core cannot tell: with no
 * snapshot held, or a row on a list this turn opened and the page has not reported, the browser
 * judges it and refuses it by the same code.
 */
export function highlightOnPageRefusal(
  page: ProjectedPage | null,
  action: UiAction,
): string | null {
  if (action.name !== 'ui.highlight' || page === null) return null;
  if (action.params.target === 'row' && page.shownUnknown) return null;
  return highlightRefusal(action.params, page.snapshot);
}

const FILTER_WIRES: ReadonlySet<string> = new Set(
  Object.values(UI_LIST_FILTER_ACTIONS).flatMap((key) => [key, UI_ACTIONS[key].wire]),
);

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * A filter call with its search taken out where the person never said its words (FB-110: asked to
 * show what waits on them, a model also searched "wait" or "/", and the list came up empty). The
 * search is the one free-text field, so it is the one a model fills from nothing; every other field
 * is a closed choice the contract checks. What was taken out is named, never dropped silently.
 */
export function withoutUnsaidSearch(
  name: string,
  args: unknown,
  said: string,
): { args: unknown; ignored: string[] } {
  if (!FILTER_WIRES.has(name) || typeof args !== 'object' || args === null) {
    return { args, ignored: [] };
  }
  const { set } = args as { set?: unknown };
  const heard = new Set(wordsOf(said));
  const unsaid = (v: unknown) =>
    typeof v === 'string' && v.trim() !== '' && !wordsOf(v).some((w) => heard.has(w));
  const note = (v: unknown) =>
    `set.text "${String(v)}" (the person said none of its words; search only for words they said)`;
  if (Array.isArray(set)) {
    const text = set.find((e) => (e as { field?: unknown })?.field === 'text') as
      | { value?: unknown }
      | undefined;
    if (!text || !unsaid(text.value)) return { args, ignored: [] };
    return {
      args: { ...args, set: set.filter((e) => e !== text) },
      ignored: [note(text.value)],
    };
  }
  if (typeof set === 'object' && set !== null && 'text' in set) {
    const { text, ...rest } = set as Record<string, unknown>;
    if (!unsaid(text)) return { args, ignored: [] };
    return { args: { ...args, set: rest }, ignored: [note(text)] };
  }
  return { args, ignored: [] };
}

export function buildUiActionToolset(
  page: { snapshot: () => UiSnapshot | null } = { snapshot: () => null },
  said?: string,
): ChatToolset {
  // the actions this turn applied, in order, so a highlight after an open is judged on that record
  const applied: UiAction[] = [];
  const projected = (): ProjectedPage | null => {
    const held = page.snapshot();
    if (!held) return null;
    return applied.reduce(pageAfter, { snapshot: held, shownUnknown: false });
  };
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
      // the contract refuses a search with no word by name first; a worded one the person never
      // said is then taken out, where the message is known
      const first = parseUiAction(name, args);
      if (!first.ok) return toolError(first.message);
      const heard =
        said === undefined ? { args, ignored: [] } : withoutUnsaidSearch(name, args, said);
      const parsed = heard.ignored.length > 0 ? parseUiAction(name, heard.args) : first;
      if (!parsed.ok) {
        return toolError(`${parsed.message} (after ${heard.ignored.join('; ')} was taken out)`);
      }
      const ignored = [...heard.ignored, ...(parsed.ignored ?? [])];
      const figures = boardFigureRefusal(parsed.action);
      if (figures) return toolError(figures);
      const offPage = highlightOnPageRefusal(projected(), parsed.action);
      if (offPage) return toolError(offPage);
      applied.push(parsed.action);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              deferred: UI_ACTION_DEFERRED,
              action: parsed.action,
              note: `Handed to the person's browser, which applies it and shows it as a card with Undo; the next message carries the page it produced.${ignored.length > 0 ? ` Ignored, not applied: ${ignored.join('; ')}.` : ''}`,
            }),
          },
        ],
      };
    },
    ranAs: () => null,
  };
}
