/**
 * ISS-1009 — what the chat door does to a `forge` argv before it runs, kept
 * free of any import that reaches a database so the rules test on their own.
 */

/// <reference path="./forge-plugin-visibility.d.ts" />

import {
  ROOM_KNOWLEDGE_READS,
  ROOM_VERBS,
  roomOpens,
  whereItIsDone,
} from '@forge/contracts/room-verbs';
import { withheldForJob } from 'forge-plugin/plugin/src/resolve/visibility.mjs';

export const CHAT_JOB = 'ba';
export const CHAT_JOB_VERBS = ROOM_VERBS;

/** What the per-turn config's `withheld` carries: every CLI verb the job does not offer. */
export function chatWithheld(): string[] {
  return withheldForJob(CHAT_JOB_VERBS);
}

/** Null when the argv may run; otherwise the refusal, naming what is open and where the act is done. */
export function admitVerb(argv: readonly string[]): string | null {
  const [verb, sub] = argv;
  if (verb === undefined) return 'nothing to run: give at least a verb, or `-h`.';
  if (roomOpens(verb, sub)) return null;
  if (verb === 'knowledge') {
    return `\`forge knowledge ${sub}\` is not open from chat; ${ROOM_KNOWLEDGE_READS.join('/')} are. ${whereItIsDone(verb)}`;
  }
  return (
    `\`forge ${verb}\` is not open from chat. What is: ${CHAT_JOB_VERBS.join(', ')}, and \`-h\` on any of them. ` +
    whereItIsDone(verb)
  );
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
