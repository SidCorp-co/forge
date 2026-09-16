/**
 * ISS-1009 — what the chat door does to a `forge` argv before it runs, kept
 * free of any import that reaches a database so the rules test on their own.
 */

import { withheldForJob } from 'forge-plugin/plugin/src/resolve/visibility.mjs';

/**
 * The `ba` job: the verbs a reporter's seat reaches. Copied from the job
 * `forge-plugin/.forge.json` declares under that name, because a chat door
 * has no checkout to read one from.
 */
export const CHAT_JOB = 'ba';
export const CHAT_JOB_VERBS: readonly string[] = [
  'issue',
  'new',
  'comment',
  'attach',
  'next',
  'spec',
  'guide',
  'project',
  'knowledge',
];

/** `forge knowledge` sub-verbs a room may reach: the reads. `write` and `delete` are a run's, not a room's. */
const KNOWLEDGE_READS: ReadonlySet<string> = new Set(['list', 'get', 'search']);

/** What the per-turn config's `withheld` carries: every CLI verb the job does not offer. */
export function chatWithheld(): string[] {
  return withheldForJob(CHAT_JOB_VERBS);
}

/** Null when the argv may run; otherwise the refusal, naming what is open. */
export function admitVerb(argv: readonly string[]): string | null {
  const [verb, sub] = argv;
  if (verb === undefined) return 'nothing to run: give at least a verb, or `-h`.';
  if (verb === '-h' || verb === '--help') return null;
  if (!CHAT_JOB_VERBS.includes(verb)) {
    return (
      `\`forge ${verb}\` is not open from chat. What is: ${CHAT_JOB_VERBS.join(', ')}, and \`-h\` on any of them. ` +
      'Configuring a machine or driving a deploy is done at a terminal.'
    );
  }
  if (verb === 'knowledge' && sub !== undefined && sub !== '-h' && !KNOWLEDGE_READS.has(sub)) {
    return `\`forge knowledge ${sub}\` is not open from chat; ${[...KNOWLEDGE_READS].join('/')} are.`;
  }
  return null;
}

export function placeBody(
  argv: readonly string[],
  body: string | undefined,
  bodyPath: string,
): string[] {
  const out = [...argv];
  if (!body) return out;
  const dash = out.indexOf('-');
  if (dash < 0) {
    throw new Error(
      'a body was given but the argv names no place for it: write `-` where the file goes, ' +
        'as in ["new","-","--title","...","--category","bug"].',
    );
  }
  out[dash] = bodyPath;
  return out;
}

/** What the model reads when the CLI was stopped before it answered. */
export function stoppedMessage(seconds: number): string {
  return (
    `forge was stopped after ${seconds}s with no answer: the tracker did not reply in time. ` +
    'Whether the write landed is NOT known — read it back (`forge issue --search "<title>"`) ' +
    'before saying either way, and before trying again.'
  );
}
