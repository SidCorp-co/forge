/**
 * Every action /mcp serves, one entry each, so a client loads only the action it uses (ISS-773):
 * `forge_find` searches the entries, `forge_describe` answers one entry's input and guide, and
 * `forge_call` runs it through its door.
 *
 * An action is `<door>.<action>`, the door being the tool's name without `forge_` (`requirements.create`,
 * `project_feedback.submit`). Its guide is its own entry in its door's description,
 * `action { args }: what it does` up to the next action's entry, and its input is the door's input
 * narrowed to that action and the arguments its entry names. A door whose tool judges each action
 * under its own strict input (`McpTool.actionInputs`) answers that input instead, with the door's
 * whole description as the guide, since its description names no action's arguments.
 *
 * A door action whose description holds no entry, or whose entry names an argument the door does
 * not take, is refused by name when the registry is built: the guide is the contract a client
 * calls by, and a slice that does not exist cannot be answered.
 */

import type { McpTool } from '../lib/tool.js';
import { listedSchema } from './listed-schema.js';

type Schema = Record<string, unknown>;

export interface ActionEntry {
  /** `<door>.<action>`, what `forge_call` and `forge_describe` take. */
  id: string;
  tool: string;
  action: string;
  /** One line: what the action does. */
  summary: string;
  /** The action's own guide, or its door's where the door's description names no action's entry. */
  guide: string;
  guideOf: 'action' | 'door';
  /** The action's input as a JSON Schema object, without `action`. */
  input: Schema;
}

const SUMMARY_MAX = 140;

/** The door a tool is reached by: its name without the `forge_` prefix. */
export const doorOf = (tool: string) => tool.replace(/^forge_/, '');

/** The actions a tool's published input takes. */
function actionsOf(tool: McpTool): string[] {
  const action = (tool.inputSchema.properties as Record<string, Schema> | undefined)?.action;
  if (!action) {
    throw new Error(
      `mcp registry: ${tool.name}'s input names no action, so its actions cannot be listed (mcp/action-catalog.ts)`,
    );
  }
  if (Array.isArray(action.enum)) return action.enum.map(String);
  if (action.const !== undefined) return [String(action.const)];
  throw new Error(
    `mcp registry: ${tool.name}'s action is neither an enum nor a const, so its actions cannot be listed (mcp/action-catalog.ts)`,
  );
}

/** The index of the `}` closing the `{` at `open`, or -1. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

type Found = {
  /** Where the entry, or the group of entries it is chained in, starts. */
  start: number;
  argsText: string | null;
  /** Where what it does starts; entries chained before one `:` share it. */
  body: number;
  /** A signature in a `;` list, whose prose is a sentence elsewhere that names it. */
  listed: boolean;
};

const CHAINED = /^\s*(?:,\s*and|,|and)\s+(?:action=)?[a-z_]+\s*\{/;

/** The position after an optional balanced `{ ... }` at `at`, with what it held. */
function bracesAt(text: string, at: number): { end: number; inner: string | null } | null {
  let i = at;
  while (text[i] === ' ') i += 1;
  if (text[i] !== '{') return { end: i, inner: null };
  const close = closingBrace(text, i);
  if (close < 0) return null;
  let end = close + 1;
  while (text[end] === ' ') end += 1;
  return { end, inner: text.slice(i + 1, close) };
}

/**
 * An action's entry in a description: the action's name at a word boundary (an `action=` before it
 * allowed), then an optional balanced `{ ... }`, then `:` — or other entries chained to it with `,` or
 * `and` before one `:` that all of them share (`verify {..} and reopen {..}: ...`), or `;` or `.` after a
 * signature in a list (`announce { text }.`), taken only where the description holds no `:` entry
 * for it. A mention of the name in a sentence is followed by none of these, so it is no entry.
 */
function entryOf(text: string, action: string): Found | null {
  const name = new RegExp(`(?<![\\w.\\-=])(?:action=)?${action}(?![\\w\\-])`, 'g');
  let listed: Found | null = null;
  for (let m = name.exec(text); m; m = name.exec(text)) {
    const own = bracesAt(text, m.index + m[0].length);
    if (!own) continue;
    let at = own.end;
    let chained = CHAINED.exec(text.slice(at));
    while (chained) {
      const next = bracesAt(text, at + chained[0].length - 1);
      if (!next) break;
      at = next.end;
      chained = CHAINED.exec(text.slice(at));
    }
    if (text[at] === ':') {
      return { start: groupStart(text, m.index), argsText: own.inner, body: at + 1, listed: false };
    }
    if (own.inner === null) continue;
    // a signature in a list, with its note: `name { .. } (what it does),` `name { .. };` `name { .. }.`
    let after = own.end;
    if (text[after] === '(') {
      const close = text.indexOf(')', after);
      if (close > 0) after = close + 1;
    }
    if (text[after] === ',' || text[after] === ';' || text[after] === '.') {
      listed ??= { start: m.index, argsText: own.inner, body: after, listed: true };
    }
  }
  return listed;
}

/** Where a chain of entries that `at` is a member of starts: back over `name {..},` and `name {..} and`. */
function groupStart(text: string, at: number): number {
  let start = at;
  for (;;) {
    const before = text.slice(0, start);
    const m = /(?:action=)?[a-z_]+\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*(?:,\s*and|,|and)\s*$/.exec(
      before,
    );
    if (!m) return start;
    start = m.index;
  }
}

/**
 * The sentence that tells what a listed action does, where its description has one: the action named
 * as a sentence's subject (`move_issue moves an issue ...`, `announce {text} is the one top-level
 * post ...`), up to the sentence's end.
 */
function proseOf(text: string, action: string): string | null {
  const name = new RegExp(`(?<![\\w.\\-=])${action}(?![\\w\\-])`, 'g');
  for (let m = name.exec(text); m; m = name.exec(text)) {
    const own = bracesAt(text, m.index + m[0].length);
    if (!own || !/^[a-z]/.test(text.slice(own.end)) || text.startsWith('and ', own.end)) continue;
    const end = /[.;](?:\s|$)/.exec(text.slice(own.end));
    return text.slice(m.index, end ? own.end + end.index + 1 : text.length).trim();
  }
  return null;
}

/** The top-level arguments an entry's `{ ... }` names, each `optional` where it is marked `?` or an alternative. */
function argumentsIn(argsText: string): { name: string; optional: boolean }[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const [i, ch] of [...argsText].entries()) {
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    // a ` — ` at the top ends the arguments: what follows explains them
    if (depth === 0 && ch === '—' && argsText[i - 1] === ' ') break;
    if ((ch === ',' || ch === ';') && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  const out: { name: string; optional: boolean }[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part || part.startsWith('...')) continue;
    // `name?: type` names one argument; `a | b` and `exactly one of a | b` name alternatives, none required
    const typed = /^([A-Za-z_]\w*)(\?)?\s*:/.exec(part);
    if (typed) {
      out.push({ name: typed[1] as string, optional: typed[2] === '?' });
      continue;
    }
    const chosen = /^(?:exactly )?one of /.test(part);
    const names = part
      .replace(/^(?:exactly )?one of /, '')
      .split('|')
      .map((a) => /^([A-Za-z_]\w*)(\?)?/.exec(a.trim()))
      .filter((m): m is RegExpExecArray => m !== null);
    for (const n of names) {
      out.push({ name: n[1] as string, optional: chosen || names.length > 1 || n[2] === '?' });
    }
  }
  return out;
}

/** The first sentence of a guide, at most SUMMARY_MAX characters. */
function summaryOf(guide: string): string {
  const flat = guide.replace(/\s+/g, ' ').trim();
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length <= SUMMARY_MAX
    ? sentence
    : `${sentence.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
}

/** The door's input narrowed to `args`, with `action` left out (`forge_call` sets it). */
function narrowedInput(
  tool: McpTool,
  action: string,
  listed: Schema,
  args: { name: string; optional: boolean }[],
): Schema {
  const properties = (listed.properties ?? {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  const required: string[] = [];
  for (const { name, optional } of args) {
    if (!(name in properties)) {
      throw new Error(
        `mcp registry: ${tool.name}'s entry for ${action} names an argument \`${name}\` its input does not take; correct the entry or the input (mcp/action-catalog.ts)`,
      );
    }
    kept[name] = properties[name];
    if (!optional) required.push(name);
  }
  // the project a door works in is an argument of every action that takes one
  if ('projectId' in properties && !('projectId' in kept)) kept.projectId = properties.projectId;
  if (
    (listed.required as string[] | undefined)?.includes('projectId') &&
    !required.includes('projectId')
  )
    required.push('projectId');
  return {
    type: 'object',
    properties: kept,
    ...(required.length > 0 ? { required } : {}),
    ...(listed.additionalProperties === false ? { additionalProperties: false } : {}),
  };
}

function entriesOf(tool: McpTool): ActionEntry[] {
  const door = doorOf(tool.name);
  const actions = actionsOf(tool);
  const listed = listedSchema(tool.name, tool.inputSchema);
  if (tool.actionInputs) {
    return actions.map((action) => {
      const own = tool.actionInputs?.[action];
      if (!own) {
        throw new Error(
          `mcp registry: ${tool.name} declares each action's input and none for ${action} (mcp/action-catalog.ts)`,
        );
      }
      const input = listedSchema(`${tool.name}.${action}`, own);
      const projectId = (listed.properties as Record<string, unknown> | undefined)?.projectId;
      const properties = { ...(input.properties as Record<string, unknown>) };
      if (projectId && !('projectId' in properties)) properties.projectId = projectId;
      return {
        id: `${door}.${action}`,
        tool: tool.name,
        action,
        summary: summaryOf(`${action}: ${tool.description}`),
        guide: tool.description,
        guideOf: 'door' as const,
        input: { ...input, properties },
      };
    });
  }
  const text = tool.description;
  const found = actions.map((action) => {
    const entry = entryOf(text, action);
    if (!entry) {
      throw new Error(
        `mcp registry: ${tool.name}'s description holds no entry for its action ${action} (\`${action} { args }: what it does\`), so forge_describe has no guide to answer for ${door}.${action} (mcp/action-catalog.ts)`,
      );
    }
    return { action, ...entry };
  });
  const starts = [...new Set(found.map((f) => f.start))].sort((a, b) => a - b);
  return found.map((f) => {
    let guide: string;
    let summary: string;
    if (f.listed) {
      const prose = proseOf(text, f.action);
      const signature = text
        .slice(f.start, f.body)
        .trim()
        .replace(/[,;.]$/, '');
      guide = prose ? `${signature} ${prose}` : signature;
      summary = summaryOf(prose ?? signature);
    } else {
      const end = starts.find((s) => s > f.start) ?? text.length;
      guide = text.slice(f.start, end).trim().replace(/^-\s*/, '');
      summary = summaryOf(text.slice(f.body, end));
    }
    return {
      id: `${door}.${f.action}`,
      tool: tool.name,
      action: f.action,
      summary,
      guide,
      guideOf: 'action' as const,
      input: narrowedInput(tool, f.action, listed, f.argsText ? argumentsIn(f.argsText) : []),
    };
  });
}

/** Every action of `tools`, by id. */
export function actionCatalog(tools: readonly McpTool[]): Map<string, ActionEntry> {
  const catalog = new Map<string, ActionEntry>();
  for (const tool of tools) {
    for (const entry of entriesOf(tool)) catalog.set(entry.id, entry);
  }
  return catalog;
}

/** The words of a text, lowercased, for matching a query. */
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/**
 * The entries a query matches, best first: each query word scores where it appears in the id,
 * the summary or the guide. No query lists every action.
 */
export function findActions(
  catalog: ReadonlyMap<string, ActionEntry>,
  query: string,
  limit: number,
): ActionEntry[] {
  const words = wordsOf(query);
  const all = [...catalog.values()];
  if (words.length === 0) return all.slice(0, limit);
  const scored = all
    .map((entry) => {
      const id = wordsOf(entry.id);
      const summary = wordsOf(entry.summary);
      const guide = new Set(wordsOf(entry.guide));
      let score = 0;
      for (const w of words) {
        if (id.some((x) => x === w || x.startsWith(w))) score += 4;
        if (summary.some((x) => x === w || x.startsWith(w))) score += 2;
        if (guide.has(w)) score += 1;
      }
      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}
