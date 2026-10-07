// What one turn has already done across its attempts: the calls a screen retry is told of, and the
// filing it may not make twice. A retry is the same turn asked again, so a write the first attempt
// made stands and is named back to the model rather than made a second time.

import type { CallToolResult } from '../lib/tool-result.js';
import { type ChatToolset, toolResultText } from './tools/mcp-adapter.js';

const FILING_TOOL = 'forge';
const RESULT_CHARS = 300;
const ARGUMENT_CHARS = 200;
const LISTED_CALLS = 16;

interface DoneCall {
  readonly said: string;
  readonly result: string;
}

export interface TurnWrites {
  /** The toolset every attempt of the turn runs through. */
  readonly tools: ChatToolset | undefined;
  /** What a retry is told the turn already did, or null when it did nothing yet. */
  doneSoFar(): string | null;
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

/** The title a `forge new` call files under, or null for any other call. */
export function filingTitle(name: string, argsJson: string): string | null {
  if (name !== FILING_TOOL) return null;
  const argv = argvOf(argsJson);
  if (argv?.[0] !== 'new') return null;
  const at = argv.indexOf('--title');
  if (at >= 0) return argv[at + 1] ?? null;
  const inline = argv.find((a) => a.startsWith('--title='));
  return inline ? inline.slice('--title='.length) : null;
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

const callSaid = (name: string, argsJson: string): string => {
  const argv = name === FILING_TOOL ? argvOf(argsJson) : null;
  return argv ? `${name} ${JSON.stringify(argv)}` : `${name} ${oneLine(argsJson, ARGUMENT_CHARS)}`;
};

function refiled(title: string, earlier: CallToolResult): CallToolResult {
  const note = `Not filed again: this turn already filed an issue titled "${title}", and the result below is that filing. Name the issue it gave; do not file it a second time.`;
  return { ...earlier, content: [{ type: 'text', text: note }, ...earlier.content] };
}

/**
 * The turn's toolset with a ledger in front: every call that lands is remembered for the retry, and
 * a second `forge new` under a title this turn already filed is answered with that filing instead
 * of a new issue.
 */
export function turnWrites(tools: ChatToolset | undefined): TurnWrites {
  const done: DoneCall[] = [];
  const filings = new Map<string, Promise<CallToolResult>>();
  if (!tools) return { tools, doneSoFar: () => null };
  const run = async (name: string, argsJson: string): Promise<CallToolResult> => {
    const result = await tools.execute(name, argsJson);
    if (!result.isError) {
      done.push({
        said: callSaid(name, argsJson),
        result: oneLine(toolResultText(result), RESULT_CHARS),
      });
    }
    return result;
  };
  const ledgered: ChatToolset = {
    ...tools,
    async execute(name, argsJson) {
      const title = filingTitle(name, argsJson);
      if (title === null) return run(name, argsJson);
      const key = titleKey(title);
      const pending = filings.get(key);
      let reused = false;
      const filing = (async () => {
        const earlier = pending ? await pending.catch(() => null) : null;
        if (earlier && !earlier.isError) {
          reused = true;
          return earlier;
        }
        return run(name, argsJson);
      })();
      filings.set(key, filing);
      const result = await filing;
      return reused ? refiled(title, result) : result;
    },
  };
  return {
    tools: ledgered,
    doneSoFar() {
      if (done.length === 0) return null;
      const listed = done.slice(-LISTED_CALLS).map((c) => `- ${c.said} → ${c.result}`);
      return [
        'What this turn already did before this rewrite: these calls ran, and what they changed stands. Do not repeat a write among them (a filing, a comment, an attachment); name what it returned instead.',
        ...listed,
      ].join('\n');
    },
  };
}
