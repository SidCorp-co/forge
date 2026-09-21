// What a parked question looks like in a room, and what a reply to it may say.
//
// Every string a run's agent wrote passes the question doors of the message
// contract before any of this reaches a room; the bodies below that carry no
// agent text are fixed constants and say so at their call site.

import { isChoiceStep, type QuestionOption, type QuestionStep } from '../../db/schema-questions.js';
import type { RoomMessage } from '../../messaging/proven.js';
import { agentAuthoredSegments } from '../../questions/screen.js';

export { OPTION_LINE_RE } from '../../messaging/option-line.js';

export function optionToken(round: number, index: number, rounds: number): string {
  return rounds > 1 ? `${round}-${index + 1}` : String(index + 1);
}

export type ParsedChoice =
  | { ok: true; round: number; index: number }
  | { ok: false; reason: 'no-token' | 'ambiguous' };

/**
 * The option a reply names, read from the reply alone.
 */
export function parseChoice(text: string, rounds: number): ParsedChoice {
  const token = text.trim().match(/^(?:(\d+)-)?(\d+)\s*[.)]?$/);
  if (!token) return { ok: false, reason: 'no-token' };
  const qualifier = token[1];
  const n = Number(token[2]);
  if (!Number.isInteger(n) || n < 1) return { ok: false, reason: 'no-token' };
  if (qualifier) return { ok: true, round: Number(qualifier), index: n - 1 };
  if (rounds > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, round: 1, index: n - 1 };
}

function optionSuffix(option: QuestionOption, recommended: boolean): string {
  const facts: string[] = [];
  if (option.authority === 'admin') facts.push('admins only');
  if (option.bindsTo === 'this_call') facts.push(`binds to this call only: ${option.fingerprint}`);
  if (option.bindsTo === 'session') facts.push('holds for this session');
  if (option.bindsTo === 'project') facts.push('holds for the whole project');
  facts.push(`carried out by the ${option.executedBy}`);
  if (recommended) facts.push('recommended');
  return ` — ${facts.join(' · ')}`;
}

export { agentAuthoredSegments };

export function renderRound(args: {
  issueKey: string | null;
  step: QuestionStep;
  rounds: number;
  parkDeadlineAt: Date | null;
  /** Whoever the asking turn was answering, where the question remembers; null where it does not. */
  askedBy?: string | null;
}): RoomMessage {
  const { step, rounds } = args;
  const about = args.askedBy ? ` on ${args.askedBy}'s question` : '';
  const head = args.issueKey
    ? `**${args.issueKey}** — a run is parked on a decision${about}.`
    : `A run is parked on a decision${about}.`;
  const lines = [head, '', step.prompt, ''];
  if (isChoiceStep(step)) {
    step.options.forEach((o, i) => {
      const token = optionToken(step.round, i, rounds);
      lines.push(`${token}. ${o.label}${optionSuffix(o, o.id === step.recommendedOptionId)}`);
    });
    const example = optionToken(step.round, 0, rounds);
    lines.push('', `Reply in this thread with the option, like \`${example}\`.`);
  } else {
    lines.push(`What would settle it: ${step.needed}`);
    lines.push('', 'Reply in this thread with the answer itself. The whole reply is taken.');
  }
  lines.push(
    args.parkDeadlineAt
      ? `Unanswered by ${args.parkDeadlineAt.toISOString()}, this question expires and the run stays parked.`
      : 'Until somebody answers, the run stays parked — nothing else resolves it.',
  );
  return { text: lines.join('\n'), screened: agentAuthoredSegments(step) };
}

/** The options again, when a reply named none of them. */
export function renderOptionsAgain(step: QuestionStep, rounds: number): RoomMessage {
  const lines = ['That reply named no option on this round. The options are:', ''];
  if (!isChoiceStep(step)) {
    return { text: lines.join('\n'), screened: agentAuthoredSegments(step) };
  }
  step.options.forEach((o, i) => {
    lines.push(`${optionToken(step.round, i, rounds)}. ${o.label}`);
  });
  lines.push('', 'Reply with one of those, and nothing else.');
  return { text: lines.join('\n'), screened: agentAuthoredSegments(step) };
}

export const AMBIGUOUS_ROUND_REPLY =
  'This question has been asked more than once, so a bare number no longer says which round it answers. Reply with the round and the option together, like `2-1`.';

export const STALE_ROUND_REPLY = (named: number, current: number): string =>
  `That answers round ${named}, and this question has moved on to round ${current}. The round you were shown has been superseded — read the latest message in this thread and answer that one.`;

export const UNKNOWN_OPTION_REPLY = (token: string): string =>
  `There is no option \`${token}\` on this round.`;

const RC_HANDLE_RE = /^[a-zA-Z0-9._-]{1,60}$/;

export const ANSWER_RECORDED = (token: string, username: string, userId: string): string => {
  const who = RC_HANDLE_RE.test(username) ? `@${username}` : `the linked account ${userId}`;
  const what = token ? `option \`${token}\`` : 'the answer as written';
  return `Recorded: ${what}, answered by ${who}. The run has been woken.`;
};

export const ANSWER_FAILED = (reason: string): string => `That answer was not recorded — ${reason}`;
