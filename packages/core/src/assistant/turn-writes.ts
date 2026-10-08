// What one turn has already done across its attempts: the calls a screen retry is told of. A retry
// is the same turn asked again, so a write the first attempt made stands and is named back to the
// model rather than made a second time; a record the turn proposes is held for the person's
// agreement (`agreement/turn-gate.ts`), one proposal per title however often it is asked again.

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

/**
 * What `forge issue` takes that changes the tracker: `--set` (fields), `--blocks`/`--relates`/`--unlink`/`--edge`
 * (edges) and `--redact`. Every other flag (`--status`, `--search`, `--limit`, `--fields`, `--full`, `--project`)
 * narrows what is read. `--propose` sends a proposal and lands nothing, so it is never a write.
 */
const ISSUE_WRITE_FLAG = /^--(set|blocks|relates|unlink|edge|redact)(=|$)/;
const PROPOSE_FLAG = /^--propose(=|$)/;
/**
 * What `forge project` takes that changes a project: `new` creates one, `<slug> --set k=v` writes a
 * field, `--archive` and `--unarchive` move it. A bare slug reads the record; no argument lists them.
 */
const PROJECT_WRITE_FLAG = /^--(set|archive|unarchive)(=|$)/;
const HELP_FLAG = /^(-h|--help)$/;
const WRITE_TOOLS: ReadonlySet<string> = new Set([
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

/** A write the turn proposed and core held for the person's agreement: nothing of it landed. */
export interface HeldCall {
  readonly name: string;
  readonly arguments: string;
  /** The held proposal, so a call restating it is told once. */
  readonly proposal: string | null;
  /** The issue and record keys its arguments name. */
  readonly keys: readonly string[];
}

/** The refusal the agreement gate answers a held write with (`agreement/turn-gate.ts`). */
const HELD_CODE = 'CHAT_WRITE_AWAITS_AGREEMENT:';
const PROPOSAL_RE = /as proposal ([0-9a-f-]{36})/;

export interface TurnWrites {
  /** The toolset every attempt of the turn runs through. */
  readonly tools: ChatToolset | undefined;
  /** What a retry is told the turn already did, or null when it did nothing yet. */
  doneSoFar(): string | null;
  /** Every call that landed so far, oldest first, across every attempt. */
  calls(): readonly DoneCall[];
  /** Every write held for the person's agreement so far, one per proposal, oldest first. */
  held(): readonly HeldCall[];
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

/** A write tool asked only to show what it would write: a read, which the agreement gate lets through. */
export function isRecordPreview(name: string, argsJson: string): boolean {
  return WRITE_TOOLS.has(name) && isPreview(argsJson);
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

/** A `forge issue` call that sends a proposal: its nature is the person's to settle, so it is told as "used", never as a write. */
export function isProposalCall(name: string, argsJson: string): boolean {
  const argv = name === CLI_TOOL ? argvOf(argsJson) : null;
  return argv?.[0] === 'issue' && argv.slice(1).some((a) => PROPOSE_FLAG.test(a));
}

function hasBody(argsJson: string): boolean {
  try {
    const body = (JSON.parse(argsJson) as { body?: unknown }).body;
    return typeof body === 'string' && body.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Did this call change something? The record and note tools, and the `forge` forms that write: `attach`;
 * `comment` only with a body (without one it reads the thread); `issue` only with a write flag;
 * `project` only as `new` or with a write flag, `-h` being a read. A form whose nature cannot be
 * told is not a write.
 */
export function isWriteCall(name: string, argsJson: string): boolean {
  if (WRITE_TOOLS.has(name)) return !isPreview(argsJson);
  if (name !== CLI_TOOL) return false;
  const argv = argvOf(argsJson);
  if (!argv?.[0]) return false;
  const rest = argv.slice(1);
  if (argv[0] === 'attach') return true;
  if (argv[0] === 'project') {
    if (rest.some((a) => HELP_FLAG.test(a))) return false;
    return rest[0] === 'new' || rest.some((a) => PROJECT_WRITE_FLAG.test(a));
  }
  if (argv[0] === 'comment')
    return rest.filter((a) => !a.startsWith('--')).length > 1 || hasBody(argsJson);
  if (argv[0] !== 'issue' || isProposalCall(name, argsJson)) return false;
  return rest.some((a) => ISSUE_WRITE_FLAG.test(a));
}

const callSaid = (name: string, argsJson: string): string => {
  const argv = name === CLI_TOOL ? argvOf(argsJson) : null;
  return argv ? `${name} ${JSON.stringify(argv)}` : `${name} ${oneLine(argsJson, ARGUMENT_CHARS)}`;
};

/** The turn's toolset with a ledger in front: every call that lands is remembered for the retry. */
export function turnWrites(tools: ChatToolset | undefined): TurnWrites {
  const done: DoneCall[] = [];
  const held = new Map<string, HeldCall>();
  const shown: ToolResultEntry[] = [];
  if (!tools) {
    return {
      tools,
      doneSoFar: () => null,
      calls: () => [],
      held: () => [],
      resultTexts: () => [],
      results: () => [],
    };
  }
  const run = async (name: string, argsJson: string): Promise<CallToolResult> => {
    const result = await tools.execute(name, argsJson);
    const text = toolResultText(result);
    shown.push({ name, text: text.slice(0, GROUNDING_CHARS), isError: result.isError === true });
    if (result.isError && text.includes(HELD_CODE)) {
      const proposal = PROPOSAL_RE.exec(text)?.[1] ?? null;
      held.set(proposal ?? `${held.size}`, {
        name,
        arguments: argsJson,
        proposal,
        keys: [...new Set(argsJson.match(ISSUE_KEY_RE) ?? [])],
      });
    }
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
    held: () => [...held.values()],
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
