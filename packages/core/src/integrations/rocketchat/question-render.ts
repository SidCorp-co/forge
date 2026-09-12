// What a parked question looks like in a room, and what a reply to it may say.
//
// Every string a run's agent wrote passes `screenOperatorMessage` before any of
// this reaches a room; the bodies below that carry no agent text are fixed
// constants and say so at their call site.

import type { QuestionOption, QuestionStep } from '../../db/schema-questions.js';

// cm:guard the ONE shape an option line takes, and `screenOperatorMessage` refuses agent text matching it — a label that renders as its own option line offers a choice nobody wrote (ISS-978 criterion 28).
export const OPTION_LINE_RE = /^\s*\d+(-\d+)?\s*[.)]/;

// cm:guard a bare number is legal ONLY while the question has one round: from round two on, two rounds may each offer an option `1` with different fingerprints, and resolving a bare number against the latest step hands somebody an action they never saw (ISS-978 criterion 16).
export function optionToken(round: number, index: number, rounds: number): string {
  return rounds > 1 ? `${round}-${index + 1}` : String(index + 1);
}

export type ParsedChoice =
  | { ok: true; round: number; index: number }
  | { ok: false; reason: 'no-token' | 'ambiguous' };

/**
 * The option a reply names, read from the reply alone.
 */
// cm:guard reads the token and NOTHING else — no fuzzy match against a label, no defaulting to the recommended option. A reply this cannot read is a refusal that re-posts the options, because guessing which option somebody meant is the one failure a locked option and a fingerprint exist to prevent (ISS-978 criterion 18).
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
  // cm:guard an option that binds to one call is a PERMISSION, and the message states its scope, its executor and the call it names or the delivery is refused — typing a number must not grant a fingerprinted allowance the person could not read (ISS-978 criterion 26).
  if (option.bindsTo === 'this_call') facts.push(`binds to this call only: ${option.fingerprint}`);
  if (option.bindsTo === 'session') facts.push('holds for this session');
  if (option.bindsTo === 'project') facts.push('holds for the whole project');
  facts.push(`carried out by the ${option.executedBy}`);
  if (recommended) facts.push('recommended');
  return ` — ${facts.join(' · ')}`;
}

/** Every agent-authored string in a round, for the screen to read before anything is posted. */
export function agentAuthoredSegments(step: QuestionStep): string[] {
  return [step.prompt, ...step.options.map((o) => o.label)];
}

export function renderRound(args: {
  issueKey: string | null;
  step: QuestionStep;
  rounds: number;
  parkDeadlineAt: Date | null;
}): string {
  const { step, rounds } = args;
  const head = args.issueKey
    ? `**${args.issueKey}** — a run is parked on a decision.`
    : 'A run is parked on a decision.';
  const lines = [head, '', step.prompt, ''];
  step.options.forEach((o, i) => {
    const token = optionToken(step.round, i, rounds);
    lines.push(`${token}. ${o.label}${optionSuffix(o, o.id === step.recommendedOptionId)}`);
  });
  const example = optionToken(step.round, 0, rounds);
  lines.push('', `Reply in this thread with the option, like \`${example}\`.`);
  lines.push(
    args.parkDeadlineAt
      ? `Unanswered by ${args.parkDeadlineAt.toISOString()}, this question expires and the run stays parked.`
      : 'Until somebody answers, the run stays parked — nothing else resolves it.',
  );
  return lines.join('\n');
}

/** The options again, when a reply named none of them. */
export function renderOptionsAgain(step: QuestionStep, rounds: number): string {
  const lines = ['That reply named no option on this round. The options are:', ''];
  step.options.forEach((o, i) => {
    lines.push(`${optionToken(step.round, i, rounds)}. ${o.label}`);
  });
  lines.push('', 'Reply with one of those, and nothing else.');
  return lines.join('\n');
}

export const AMBIGUOUS_ROUND_REPLY =
  'This question has been asked more than once, so a bare number no longer says which round it answers. Reply with the round and the option together, like `2-1`.';

export const STALE_ROUND_REPLY = (named: number, current: number): string =>
  `That answers round ${named}, and this question has moved on to round ${current}. The round you were shown has been superseded — read the latest message in this thread and answer that one.`;

export const UNKNOWN_OPTION_REPLY = (token: string): string =>
  `There is no option \`${token}\` on this round.`;

// cm:guard the handle is matched against Rocket.Chat's own alphabet before it is interpolated, and anything else is reported as the mapped Forge user instead: a display name is user-supplied text, and this line is posted under FIXED_REPLY_CONSTANT, which promises the string is code-authored (ISS-978 criterion 10).
const RC_HANDLE_RE = /^[a-zA-Z0-9._-]{1,60}$/;

export const ANSWER_RECORDED = (token: string, username: string, userId: string): string => {
  const who = RC_HANDLE_RE.test(username) ? `@${username}` : `the linked account ${userId}`;
  return `Recorded: option \`${token}\`, answered by ${who}. The run has been woken.`;
};

export const ANSWER_FAILED = (reason: string): string => `That answer was not recorded — ${reason}`;
