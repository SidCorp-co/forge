/**
 * ISS-1009 — what the chat door does to a `forge` argv before it runs, kept
 * free of any import that reaches a database so the rules test on their own.
 */

// cm:guard the reference is what carries `forge-plugin-visibility.d.ts` into every program that compiles this file, because the plugin ships plain `.mjs`, and `@forge/contracts` builds core under a tsconfig whose `include` is its own `src/**`, so without this line the import below falls to TS7016 there (ISS-1006, ISS-1009).
/// <reference path="./forge-plugin-visibility.d.ts" />

import { withheldForJob } from 'forge-plugin/plugin/src/resolve/visibility.mjs';

/**
 * The `ba` job: the verbs a reporter's seat reaches. Copied from the job
 * `forge-plugin/.forge.json` declares under that name, because a chat door
 * has no checkout to read one from.
 */
// cm:guard `jobs.ba.verbs` in the forge-plugin repo's own `.forge.json` is the SOURCE of this list and lives in another repository, which is why this is a guard and not a `cm:edge`: a verb added there is one chat still refuses until it is added here, and one removed there is one chat still offers — check that file when this list changes (ISS-1009).
// cm:guard `withheld` in the CLI's config HIDES a verb from `forge -h` and does not refuse it at run — `withheldVerbs()` is read by `doctor-keys` and `doctor-jobs` only (checked 2026-09-15 in both the pinned and the installed copy) — so this list is written to the config for what the model is SHOWN and checked in `admitVerb` for what it may RUN. The credential's permissions are the fence under both (ISS-1009).
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

// cm:guard the body is SUBSTITUTED for the `-` the caller wrote and never spliced into a position this code picked: splicing at argv[1] turned `guide writing-an-issue` into `guide <path> writing-an-issue` and `issue --search q` into the read-one-issue form, so every call in a measured turn failed on an argument the model never sent (2026-09-15, ISS-1009). An empty body is no body.
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
// cm:guard it says the outcome is UNKNOWN and never "nothing was filed": a kill on the timeout can land after the tracker committed the write, so a message that asserted a non-write would be the confabulation this issue exists to stop, in the door's own voice (consult F1, 2026-09-15, ISS-1009).
export function stoppedMessage(seconds: number): string {
  return (
    `forge was stopped after ${seconds}s with no answer: the tracker did not reply in time. ` +
    'Whether the write landed is NOT known — read it back (`forge issue --search "<title>"`) ' +
    'before saying either way, and before trying again.'
  );
}
