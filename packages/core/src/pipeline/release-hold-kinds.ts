/**
 * What each way the automatic release declines a row says (ISS-1215): the reason stored on the
 * row for an agent or an operator, and the three sentences its comment is written in for a person
 * — what holds it, what a person does, what happens then (ISS-1421 r8, criterion 90). Storage and
 * the comment itself are `release-hold.ts`'s.
 */

import { MARK_MERGED_ACTION, WHERE_IT_LANDED_FIELD } from '@forge/contracts/mark-merged-words';
import type { IssueCriteriaReport } from '../issues/criteria-verdicts.js';
import { type ServingReading, servingClause } from '../release-batch/serving-reading.js';
import { shortfallSentence } from '../release-batch/shortfall-words.js';
import type { RuntimeReading } from '../release-batch/weighing.js';
import type { HoldWords, ReleaseHold } from './release-hold.js';

const NEXT_WEIGHS = 'The next sweep weighs it again.';
/** The most words one sentence of a hold comment runs to (ISS-1421 r9). */
export const HOLD_SENTENCE_WORDS = 20;
const wordsIn = (sentence: string): number => sentence.trim().split(/\s+/).length;
const UNREAD_ACT = 'Nobody needs to act unless this repeats, and then a person reports it.';

function criteriaNamed(numbers: readonly number[]): string {
  if (numbers.length === 1) return `criterion ${numbers[0]}`;
  return `each of criteria ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** One clause per distinct reason, carrying every criterion it holds, in first-criterion order. */
function reasonsByWhy(report: IssueCriteriaReport): string {
  const byWhy = new Map<string, number[]>();
  for (const c of report.unearned) byWhy.set(c.why, [...(byWhy.get(c.why) ?? []), c.criterion]);
  return [...byWhy].map(([why, numbers]) => `${criteriaNamed(numbers)}: ${why}`).join('; ');
}

/** What one declared runtime was read as running, for the judge clause (ISS-1368). */
function runtimeClause(runtime: RuntimeReading): string {
  const { serving } = runtime;
  const read =
    serving.kind === 'serving'
      ? servingClause(serving)
      : serving.kind === 'unreadable'
        ? `nothing could be read, read at ${serving.readAt}: ${serving.why}`
        : `nothing reports it: ${serving.missing}`;
  return `the \`${runtime.name}\` runtime, under ${runtime.paths.map((p) => `\`${p}\``).join(', ')}: ${read}`;
}

/** Where a verdict has to be judged to count — the one place the reading is said (ISS-1346). */
function judgeClause(serving: ServingReading, runtimes: readonly RuntimeReading[]): string {
  const deployment = deploymentClause(serving, runtimes);
  if (serving.kind === 'serving' || runtimes.length === 0) return deployment;
  // The allowance above is the deployment's: a declared runtime with nothing read still holds.
  return (
    `${deployment}. A criterion held in a declared runtime earns only at a build it is running — ` +
    runtimes.map(runtimeClause).join('; ')
  );
}

function deploymentClause(serving: ServingReading, runtimes: readonly RuntimeReading[]): string {
  if (serving.kind === 'serving' && runtimes.length > 0) {
    return (
      'record a verdict on each criterion named, judged at a commit the runtime it is held in is ' +
      `running — the deployment: ${servingClause(serving)}; ${runtimes.map(runtimeClause).join('; ')}`
    );
  }
  if (serving.kind === 'serving') {
    return (
      'record a verdict on each criterion named, judged at a commit this project is serving — ' +
      servingClause(serving)
    );
  }
  if (serving.kind === 'unreadable') {
    const asked = serving.hosts.length === 0 ? '' : ` (read from ${serving.hosts.join(', ')})`;
    return (
      `nothing could be read from what this project answers through${asked}, read at ` +
      `${serving.readAt}: ${serving.why}. Record a verdict on each criterion named — a verdict ` +
      'nothing could check still earns the criterion, and this sentence is why it reads as weaker'
    );
  }
  return (
    `nothing here can read what this project is serving: ${serving.missing}. To give it a way, ` +
    `${serving.route}, then record a verdict on each criterion named`
  );
}

/** The criteria a comment names: up to three by number, more by count. */
function criteriaHeld(report: IssueCriteriaReport): string {
  const numbers = [...new Set(report.unearned.map((c) => c.criterion))];
  if (numbers.length === 1) return `criterion ${numbers[0]} is`;
  return numbers.length > 3
    ? `${numbers.length} of its criteria are`
    : `criteria ${listed(numbers.map(String))} are`;
}

/**
 * Owed by a person: nothing dispatched claims a row at `awaiting_release`, and the release that
 * would is the one holding it, so every act that moves the row from here is somebody's by hand.
 * A failed repository read's clearing act leads the remedy, once: a new verdict does not repair it.
 */
export function criteriaHold(report: IssueCriteriaReport): ReleaseHold {
  if (report.unresolvedLanding) return unresolvedLandingHold(report, report.unresolvedLanding);
  const reasons = reasonsByWhy(report);
  const judge = judgeClause(report.serving, report.runtimes);
  const clears = [...new Set(report.unearned.flatMap((c) => c.clears ?? []))];
  const others = `${judge}; or, having seen the change running in production, close the issue by hand; or move it out of Awaiting release if it is not to ship.`;
  const remedy =
    clears.length === 0
      ? `A person clears this: ${others}`
      : `A person clears this by making the repository readable: ${clears.join('; and ')}. The next sweep then weighs it again. Otherwise: ${others}`;
  const readable = clears.length === 0 ? '' : 'the repository readable again, ';
  const held = criteriaHeld(report);
  const words: HoldWords =
    clears.length === 0
      ? [
          `The automatic release leaves this issue out, because ${held} not earned at the deployment.`,
          'A person records a verdict on each at the running deployment, or closes the issue by hand.',
          NEXT_WEIGHS,
        ]
      : [
          `The automatic release leaves this issue out, because ${held} unearned and its repository is unreadable.`,
          'A person makes the repository readable to Forge again, then records a verdict on each or closes the issue.',
          NEXT_WEIGHS,
        ];
  return {
    code: 'RELEASE_CRITERIA_UNEARNED',
    reason:
      'The automatic release carries only an issue whose every acceptance criterion is earned, and ' +
      `this one is not — ${reasons}. ${remedy}`,
    owes: 'human',
    waitingFor: `${readable}a verdict on each criterion named at the running deployment, or the issue closed by hand`,
    words,
  };
}

/** The act that corrects a recorded landing, by the record it was read from. */
const CORRECT_THE_RECORD = {
  merge: 'A person removes its merge mark, then marks it merged at the commit that landed.',
  landing: 'Its run records the landing again at the commit that landed.',
} as const;

/**
 * A commit the issue records as landed that its repository does not hold holds every source verdict
 * back for one reason, and no verdict clears it: the record does (ISS-1300). It is said first and
 * once, and every other reason a criterion is held for follows it.
 */
function unresolvedLandingHold(
  report: IssueCriteriaReport,
  landing: NonNullable<IssueCriteriaReport['unresolvedLanding']>,
): ReleaseHold {
  const correct = CORRECT_THE_RECORD[landing.from];
  const record = landing.from === 'merge' ? 'the merge mark' : 'the landing record';
  const reasons = reasonsByWhy(report);
  // A criterion held only by its own `fail` names no commit, so the record is named here instead.
  const named = reasons.includes(landing.commit)
    ? ''
    : ` It records ${landing.commit} as landed, which ${landing.repository} does not hold.`;
  return {
    code: 'RELEASE_CRITERIA_UNEARNED',
    reason:
      'The automatic release carries only an issue whose every acceptance criterion is earned, and ' +
      `this one is not — ${reasons}.${named} ${correct} The next sweep then weighs its verdicts again.`,
    owes: 'human',
    waitingFor: `${record} corrected to the commit that landed`,
    words: [
      'The automatic release leaves this issue out, because the commit it records as landed is not in its repository.',
      correct,
      NEXT_WEIGHS,
    ],
  };
}

/**
 * The one reason every criteria-held row of a project with no runtime route shares (ISS-1346).
 * No run can clear it: nothing can read what the project serves, so no verdict a run writes can
 * be weighed. It is the project's to answer, and the sweep comments it on one row alone.
 */
export function runtimeUnroutedHold(missing: string, route: string): ReleaseHold {
  return {
    code: 'RELEASE_RUNTIME_UNROUTED',
    reason:
      `The automatic release carries only an issue whose every acceptance criterion is earned at ` +
      `what this project is serving, and nothing here can read what it is serving: ${missing}, ` +
      'and no live binding declares `verify.probes`. No verdict a run records can be weighed until ' +
      `that changes, so this is the project's to answer and not this issue's: ${route}, and the ` +
      'next sweep weighs every waiting issue again.',
    owes: 'human',
    waitingFor: 'a way for this project to be read for what it is serving',
    words: [
      "The automatic release cannot read what this project is serving, so no waiting issue's criteria can be weighed.",
      'A person gives this project a deploy binding that reports the commit it serves, under Settings → Integrations.',
      'The next sweep then weighs every waiting issue again.',
    ],
  };
}

type Shortfall = { code: string; reason: string; clears: string; clearsHere?: string };

/** One shortfall's act as a clause of the comment's list, in the page's own control names. */
function shortfallStep(s: Shortfall): string {
  if (s.code === 'OPEN_QUESTIONS') {
    return /^holds 1 /.test(s.reason)
      ? 'answer the question in the Decision waiting card above'
      : 'answer the questions in the Decision waiting cards above';
  }
  if (s.code === 'CLOSE_REQUIRES_SHIPPED') {
    // The panel Mark merged opens says what Where it landed takes; the step stays one short clause.
    return `use ${MARK_MERGED_ACTION} in its properties and fill in ${WHERE_IT_LANDED_FIELD}`;
  }
  const act = s.clearsHere ?? s.clears;
  if (s.code === 'ENTRY_CRITERIA_UNMET') {
    return /Open session/.test(act)
      ? 'press Open session at the top of this page, and the agent writes the missing records'
      : 'use Reopen in the actions menu at the top, and an agent writes the missing records';
  }
  return `${act.charAt(0).toLowerCase()}${act.slice(1)}`
    .replace(/\.$/, '')
    .replace(/\. /g, ', then ');
}

const capitalised = (clause: string): string =>
  `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;

/** What the finish's close would refuse this row for, which the sweep reads before it cuts (ISS-1337). */
export function closeRefusedHold(shortfalls: readonly Shortfall[]): ReleaseHold {
  const said = shortfalls.map((s) => shortfallSentence(s.reason).replace(/^It/, 'it').slice(0, -1));
  const acts = shortfalls.map((s) => s.clearsHere ?? s.clears).join(' ');
  // Each reason is a line of its own, the banner's sentence and then its act, however many there
  // are: joined to the opening, one reason ran past `HOLD_SENTENCE_WORDS` once a project required
  // four records (ISS-1421 r11), and a line keeps the comment to its three parts.
  const one = shortfalls.length === 1;
  const words: HoldWords = [
    one
      ? 'The automatic release cannot close this issue.'
      : `The automatic release cannot close this issue, for ${shortfalls.length} reasons.`,
    shortfalls
      .map((s) => `- ${shortfallSentence(s.reason)} ${capitalised(shortfallStep(s))}.`)
      .join('\n'),
    one
      ? 'The next sweep releases it once that is done.'
      : 'The next sweep releases it once each is done.',
  ];
  return {
    code: 'RELEASE_ISSUES_UNCLOSABLE',
    reason:
      `The automatic release leaves this issue out, because ${said.join(', ')} and its close would ` +
      `be refused. ${acts} The next sweep releases it once that is done.`,
    owes: shortfalls.some((s) => s.code === 'OPEN_QUESTIONS') ? 'human' : 'agent',
    waitingFor: 'what its close is refused for to be cleared',
    words,
  };
}

/** A read the sweep could not make: nothing a person does clears it but a repeat reported. */
function unreadHold(
  code: string,
  what: string,
  reason: string,
  waitingFor: string,
  then: string,
): ReleaseHold {
  return {
    code,
    reason,
    owes: 'human',
    waitingFor,
    words: [`The automatic release could not read ${what}.`, UNREAD_ACT, then],
  };
}

export function closeUnreadableHold(message: string): ReleaseHold {
  return unreadHold(
    'RELEASE_CLOSE_UNREADABLE',
    'whether this issue can be closed, so it did not carry it',
    'Whether this issue could be closed by a release could not be read, so the automatic ' +
      `release did not carry it: ${message}. Nothing was claimed or moved, and the next sweep ` +
      'reads it again.',
    'the close check to be readable',
    'The next sweep reads it again.',
  );
}

export function targetUndeclaredHold(message: string): ReleaseHold {
  return {
    code: 'RELEASE_TARGET_UNDECLARED',
    reason: message,
    owes: 'human',
    waitingFor: 'a live deploy binding for the release to land on',
    words: [
      'A release has nowhere to land, because no active deploy binding of this project carries its live stage.',
      'A person adds one under Settings → Integrations, or chooses "Repository, no release" under Shape & release.',
      'The next sweep then releases the waiting issues.',
    ],
  };
}

export function gateUnreadableHold(message: string): ReleaseHold {
  return unreadHold(
    'RELEASE_GATE_UNREADABLE',
    "this project's release gate, so it decided nothing about this issue",
    `The release gate for this project could not be read, so the automatic release did not ` +
      `decide anything about this issue: ${message}. Nothing was claimed or moved, and the next ` +
      'sweep reads the gate again.',
    'the release gate to be readable',
    'The next sweep reads the gate again.',
  );
}

export function criteriaUnreadableHold(message: string): ReleaseHold {
  return unreadHold(
    'RELEASE_CRITERIA_UNREADABLE',
    'the verdicts on this issue, so it could not weigh its criteria',
    `The verdicts on this issue could not be read, so the automatic release could not tell ` +
      `whether its criteria are earned: ${message}. Nothing was claimed or moved, and the next ` +
      'sweep reads them again.',
    'the verdicts to be readable',
    'The next sweep reads them again.',
  );
}

export function queuedBehindHold(carried: number): ReleaseHold {
  return {
    code: 'RELEASE_QUEUED_BEHIND',
    reason:
      `One release carries at most ${carried} issues, the oldest merges first, and this one is ` +
      'behind them. It was not sent this tick and goes in a later automatic release.',
    owes: 'agent',
    waitingFor: 'a later automatic release',
    words: [
      `One release carries at most ${carried} issues, oldest merge first, and this one is behind them.`,
      'Nobody needs to act.',
      'A later automatic release carries it.',
    ],
  };
}

export const NO_RELEASE_GATE_HOLD: ReleaseHold = {
  code: 'NO_RELEASE_GATE',
  reason:
    'This project declares no release (its release chain is empty), so there is no release for ' +
    'the automatic sweep to carry this issue into, and nothing will move it from ' +
    'Awaiting release. Either declare a release chain with a live deploy binding, or close the ' +
    'issue.',
  owes: 'human',
  waitingFor: 'a person to declare a release or close the issue',
  words: [
    'This project declares no release, so nothing carries this issue on from Awaiting release.',
    'A person declares a release chain under Settings → Shape & release, or closes the issue.',
    'The next sweep then releases it.',
  ],
};

// A refusal that clears itself (a release already running, a claim another writer won) is owed by
// the release path; every other one names a declaration or a fleet a person has to change.
const SELF_CLEARING: Readonly<Record<string, string>> = {
  BATCH_IN_FLIGHT: 'the release already in flight to finish',
  CLAIM_CONFLICT: 'the next sweep, after the claim another writer took is settled',
};

/**
 * A refusal's words without the heartbeat ages `runnerHoldClause` puts in them. An age moves every
 * tick while the refusal stands still, so kept in, it would read as a new reason each sweep and
 * comment every minute of an outage; stored, it would be false a minute later.
 */
const AGED =
  / (It is up and reporting), last seen [\w ]+ ago\.| (?:It last reported|Last seen) [\w ]+ ago\./g;
export function withoutAges(text: string): string {
  return text.replace(AGED, (_aged, up: string | undefined) => (up ? ` ${up}.` : ''));
}

/** A refusal's first sentence as the clause after "because", in plain words. */
function firstClause(reasons: readonly string[]): string {
  const first =
    withoutAges(reasons[0] ?? '')
      .replace(/`/g, '')
      .split(/(?<=\.)\s+/)[0] ?? '';
  const lead = /^(A|An|The|No|This|Its|It|Every|One|None|Nothing)\b/.test(first);
  return (lead ? `${first.charAt(0).toLowerCase()}${first.slice(1)}` : first).replace(/\.$/, '');
}

export function refusalHold(code: string, reasons: readonly string[]): ReleaseHold {
  const selfClearing = SELF_CLEARING[code];
  const because = `The automatic release was refused, because ${firstClause(reasons)}.`;
  return {
    code,
    reason: withoutAges(`The automatic release was refused: ${reasons.join(' ')}`),
    owes: selfClearing ? 'agent' : 'human',
    waitingFor: selfClearing ?? 'the refusal named here to be cleared',
    words: [
      // A reason too long for one sentence is left to the page that lists it, never cut mid-clause.
      wordsIn(because) <= HOLD_SENTENCE_WORDS
        ? because
        : 'The automatic release was refused, for a reason Settings → Shape & release lists.',
      selfClearing
        ? 'Nobody needs to act.'
        : 'A person clears what Settings → Shape & release lists under "Can this project release?".',
      'The next sweep tries the release again.',
    ],
  };
}

export function cutFailedHold(reasons: readonly string[]): ReleaseHold {
  return {
    code: 'RELEASE_CUT_FAILED',
    reason:
      `An automatic release attempt failed: ${withoutAges(reasons.join(' '))} This issue is unchanged: not ` +
      'claimed, not moved, no half-release. The next sweep tries again on its own.',
    owes: 'human',
    waitingFor: 'the failure named here to be fixed',
    words: [
      'An automatic release attempt failed, and this issue was left as it was.',
      UNREAD_ACT,
      'The next sweep tries again on its own.',
    ],
  };
}
