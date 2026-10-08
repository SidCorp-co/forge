// What one turn has already done across its attempts: the calls a screen retry is told of. A retry
// is the same turn asked again, so a write the first attempt made stands and is named back to the
// model rather than made a second time; a record the turn proposes is held for the person's
// agreement (`agreement/turn-gate.ts`), one proposal per title however often it is asked again.

import { CHAT_AGREE_TOOL } from '@forge/contracts/chat-proposals';
import type { CallToolResult } from '../lib/tool-result.js';
import type { ToolResultEntry } from '../messaging/facts.js';
import { type ChatToolset, toolResultText } from './tools/mcp-adapter.js';

const CLI_TOOL = 'forge';
/** The tools that record a new item under a title: a retry naming the same title is the same record. */
const RECORD_TOOLS: ReadonlySet<string> = new Set(['forge_feedback', 'forge_requirement_draft']);
const RESULT_CHARS = 300;
const ARGUMENT_CHARS = 200;
const LISTED_CALLS = 16;
/** What the reply screen reads of one result: the body the model was shown, up to the tool cap. */
const GROUNDING_CHARS = 24_000;

/** The `forge` verbs that change the tracker, and the flags that make `forge issue` one of them. */
const WRITE_VERBS: ReadonlySet<string> = new Set(['comment', 'attach']);
const ISSUE_WRITE_FLAG =
  /^--(status|relates|blocks|priority|assign|assignee|title|category|label|labels|module|with)(=|$)/;
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  CHAT_AGREE_TOOL,
  'forge_memory_note',
  'forge_preferences',
  'forge_feedback',
  'forge_requirement_draft',
  'forge_requirement_revise',
  'forge_template_save',
]);

/** One call that landed this turn, as the partial reply and the retry name it. */
export interface DoneCall {
  /** The tool and the arguments it was called with, as the model wrote them. */
  readonly name: string;
  readonly arguments: string;
  readonly said: string;
  readonly result: string;
  /** It changed something: a record, a comment, an attachment, a status, a note. */
  readonly write: boolean;
  /** The issue keys its result names, in the order it names them. */
  readonly keys: readonly string[];
}

export interface TurnWrites {
  /** The toolset every attempt of the turn runs through. */
  readonly tools: ChatToolset | undefined;
  /** What a retry is told the turn already did, or null when it did nothing yet. */
  doneSoFar(): string | null;
  /** Every call that landed so far, oldest first, across every attempt. */
  calls(): readonly DoneCall[];
  /** The text of every result the model was shown this turn, refused ones included. */
  resultTexts(): readonly string[];
  /** The same results by the tool that returned each, a refused one marked so: a declared read grounds a figure (`figures-rule.ts`). */
  results(): readonly ToolResultEntry[];
}

const oneLine = (text: string, cap: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
};

function argvOf(argsJson: string): string[] | null {
  try {
    const argv = (JSON.parse(argsJson) as { argv?: unknown }).argv;
    return Array.isArray(argv) && argv.every((a) => typeof a === 'string') ? argv : null;
  } catch {
    return null;
  }
}

/** A record tool asked only to show what it would record (`preview: true`): a read, which files nothing. */
function isPreview(argsJson: string): boolean {
  try {
    return (JSON.parse(argsJson) as { preview?: unknown }).preview === true;
  } catch {
    return false;
  }
}

/** The title a record tool files a new item under, or null for any other call and for a preview. */
export function filingTitle(name: string, argsJson: string): string | null {
  if (!RECORD_TOOLS.has(name) || isPreview(argsJson)) return null;
  try {
    const title = (JSON.parse(argsJson) as { title?: unknown }).title;
    return typeof title === 'string' && title.trim() ? title : null;
  } catch {
    return null;
  }
}

/** Two titles are the same filing when they differ only in case, spacing or closing punctuation. */
export function titleKey(title: string): string {
  return title
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“‘]+|["'”’.!?:;]+$/g, '');
}

const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;

/** Did this call change something? The `forge` verbs and flags that write, and the record and note tools. */
export function isWriteCall(name: string, argsJson: string): boolean {
  if (WRITE_TOOLS.has(name)) return !isPreview(argsJson);
  if (name !== CLI_TOOL) return false;
  const argv = argvOf(argsJson);
  if (!argv?.[0]) return false;
  if (WRITE_VERBS.has(argv[0])) return true;
  return argv[0] === 'issue' && argv.slice(1).some((a) => ISSUE_WRITE_FLAG.test(a));
}

const callSaid = (name: string, argsJson: string): string => {
  const argv = name === CLI_TOOL ? argvOf(argsJson) : null;
  return argv ? `${name} ${JSON.stringify(argv)}` : `${name} ${oneLine(argsJson, ARGUMENT_CHARS)}`;
};

/** The turn's toolset with a ledger in front: every call that lands is remembered for the retry. */
export function turnWrites(tools: ChatToolset | undefined): TurnWrites {
  const done: DoneCall[] = [];
  const shown: ToolResultEntry[] = [];
  if (!tools) {
    return {
      tools,
      doneSoFar: () => null,
      calls: () => [],
      resultTexts: () => [],
      results: () => [],
    };
  }
  const run = async (name: string, argsJson: string): Promise<CallToolResult> => {
    const result = await tools.execute(name, argsJson);
    const text = toolResultText(result);
    shown.push({ name, text: text.slice(0, GROUNDING_CHARS), isError: result.isError === true });
    if (!result.isError) {
      done.push({
        name,
        arguments: argsJson,
        said: callSaid(name, argsJson),
        result: oneLine(text, RESULT_CHARS),
        write: isWriteCall(name, argsJson),
        keys: [...new Set(text.match(ISSUE_KEY_RE) ?? [])],
      });
    }
    return result;
  };
  const ledgered: ChatToolset = { ...tools, execute: run };
  return {
    tools: ledgered,
    calls: () => [...done],
    resultTexts: () => shown.map((r) => r.text),
    results: () => [...shown],
    doneSoFar() {
      if (done.length === 0) return null;
      const listed = done.slice(-LISTED_CALLS).map((c) => `- ${c.said} → ${c.result}`);
      return [
        'What this turn already did before this rewrite: these calls ran, and what they changed stands. Do not repeat a write among them (a record, a comment, an attachment); name what it returned instead.',
        ...listed,
      ].join('\n');
    },
  };
}
