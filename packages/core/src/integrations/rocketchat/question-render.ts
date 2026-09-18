// What a parked question looks like in a room, and what a reply to it may say.
//
// Every string a run's agent wrote passes the question doors of the message
// contract before any of this reaches a room; the bodies below that carry no
// agent text are fixed constants and say so at their call site.

import { isChoiceStep, type QuestionOption, type QuestionStep } from '../../db/schema-questions.js';

// cm:edge contract -> packages/core/src/messaging/option-line.ts — the renderer and the rule that refuses a label colliding with it read ONE constant. Declaring a second here is how a label starts rendering as an option the rule already let through.
export { OPTION_LINE_RE } from '../../messaging/option-line.js';

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

// cm:edge contract -> packages/core/src/questions/screen.ts — re-exported, not restated. The ask door and the delivery door screen the SAME strings of the same round; two lists drifting apart is how a round passes at the ask and is refused at delivery, owed to a person and never posted.
export { agentAuthoredSegments } from '../../questions/screen.js';

// cm:guard the asker is named in the HEAD and never as a Rocket.Chat mention: a round is posted as a thread reply under that person's own message, so they are already notified, and an `@` here would ping them a second time for the same line. Naming them is for everyone ELSE in the room — it says whose question this came out of, which is what makes a colleague who knows the answer able to give it (ISS-1091 criterion 3).
export function renderRound(args: {
  issueKey: string | null;
  step: QuestionStep;
  rounds: number;
  parkDeadlineAt: Date | null;
  /** Whoever the asking turn was answering, where the question remembers; null where it does not. */
  askedBy?: string | null;
}): string {
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
    // cm:guard the round says what would SETTLE it, and the instruction says the whole reply is the answer — a free-text round that reads like a choice round invites a bare number, which this round has nothing to resolve against (ISS-996).
    lines.push(`What would settle it: ${step.needed}`);
    lines.push('', 'Reply in this thread with the answer itself. The whole reply is taken.');
  }
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
  if (!isChoiceStep(step)) return lines.join('\n');
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

// cm:guard a free-text answer is confirmed as an ANSWER and never as `option \`\``: the empty token is what a text round leaves behind, and a receipt naming an option nobody chose tells the person the wrong thing about what was just recorded (ISS-996).
export const ANSWER_RECORDED = (token: string, username: string, userId: string): string => {
  const who = RC_HANDLE_RE.test(username) ? `@${username}` : `the linked account ${userId}`;
  const what = token ? `option \`${token}\`` : 'the answer as written';
  return `Recorded: ${what}, answered by ${who}. The run has been woken.`;
};

export const ANSWER_FAILED = (reason: string): string => `That answer was not recorded — ${reason}`;
