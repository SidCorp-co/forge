/**
 * What a person reads on Shape & release for each release reason, beside the sentence a caller
 * reads. Most reasons read alike to both. A reason whose caller sentence names an act only an API
 * caller takes — a flag to read, a field to send, a JSON shape — says the person's act in words
 * instead, the way `statusLabel` and `statusForCaller` split one status (ISS-1229 r8, judge-20).
 */

import type { ReleaseBlockerCode } from '@forge/contracts';
import { lackingCheckClause, refusedCheckClause } from '../issues/landing-correction.js';
import type { RunnerHold } from '../runners/ineligible.js';
import {
  namedHere,
  type RefusedDeclaration,
  type ReleaseBlocker,
  type ReleaseWarning,
  type ReleaseWarningCode,
  releaseBlockerSentence,
  runnerPreferenceUnmetSentence,
  type UnclosableIssueRef,
  unclosableSentence,
  unreadableSentence,
} from './blocker-sentences.js';
import { carriedUndecidedSentence } from './carried-sentences.js';
import { agree, counted } from './counted.js';
import { runnerHoldReaderClause, runnersHeldSentence } from './runner-hold-sentences.js';

/** Every check a release reason can stand in for, as a person names the work it does. */
export const RELEASE_CHECK_WORDS = {
  project: "Reading this project's settings",
  knowledge: "Reading this project's written instructions",
  declaration: "Reading this project's release declaration",
  channels: "Reading this project's live deploy targets",
  'auto-release': 'Reading whether this project releases without a person',
  roster: 'Reading which issues wait at the release gate',
  'near-gate': 'Counting the issues one move short of the release gate',
  claim: 'Reading which issues another release has claimed',
  'release-record': 'Reading which issues have a release note',
  close: 'Checking whether each issue could be closed',
  criteria: "Weighing each issue's acceptance criteria",
  carried: 'Reading which landings this release would carry beyond its issues',
  'runner-pool': "Reading this project's runners",
  'runner-holds': 'Reading why each runner cannot take a release',
  'in-flight': 'Reading whether a release is already running',
  'issue-display-ids': "Reading the issues' names",
} as const;

export type ReleaseCheck = keyof typeof RELEASE_CHECK_WORDS;

type Details = Record<string, unknown> | undefined;

/** `same`: the caller's sentence already says the act in a person's words. */
type Reader = 'same' | ((details: Details) => string | null);

/** Where the repository answered why, a person reads only that answer: the request it was read by
 *  stays in `details.detail`, behind the sentence (ISS-1300 r4). Only a read nothing explained is
 *  quoted, and only that one is worth loading the page again for. */
function uncheckedSentence(details: Details): string {
  const check = details?.check;
  const what =
    typeof check === 'string' && Object.hasOwn(RELEASE_CHECK_WORDS, check)
      ? `${RELEASE_CHECK_WORDS[check as ReleaseCheck]} failed`
      : 'One of the checks that decides whether a release may start could not be run';
  const answered = lackingCheckClause(details) ?? refusedCheckClause(details);
  if (answered) return `${what}: ${answered}`;
  const detail =
    typeof details?.detail === 'string' ? ` (${details.detail.replace(/\.$/, '')})` : '';
  return `${what}${detail}, so this answer cannot say whether a release would start: whatever that check would have found is missing from this list, and every other reason here was found by a check that did run. Load this page again to retry it.`;
}

function carriedWaysOutForReader(n: number): string {
  const w = (one: string, many: string) => agree(n, one, many);
  return `${w('It is not', 'None of them is')} released until a person decides ${w('it', 'each one')}: when you release, choose Release unverified, Reverted or Cut below for ${w('it', 'each')} in the Batch release dialog, or bring ${w('it', 'each')} to Awaiting release so the release names it.`;
}

function carriedForReader(details: Details): string | null {
  if (!details || !Array.isArray(details.carried)) {
    return `This release promotes a range that carries the landing of issues nobody put on it. ${carriedWaysOutForReader(2)}`;
  }
  return carriedUndecidedSentence(details, carriedWaysOutForReader);
}

/** What a missing note costs, said as what happens rather than in the team's word for a release. */
const NOTHING_TOLD = 'with nothing telling users what changed';

/** What a note holds, wherever one is asked for. */
const NOTE_HOLDS = 'the one line a user would read, or that nothing a user sees changed';

/** One issue's note and several issues' notes are two sentences: "give each one" read as giving the
 *  issue, and "each page" named no page (ISS-1421 r39, judge-160). */
function recordMissingForReader(details: Details): string {
  const n = Array.isArray(details?.issueIds) ? details.issueIds.length : 2;
  const who =
    details && Array.isArray(details.issueIds) ? namedHere(details) : 'The issues named here';
  if (n === 1) {
    return `${who} has no release note, so a release would close it ${NOTHING_TOLD}. Write one first, under Release note on the issue's page: ${NOTE_HOLDS}.`;
  }
  return `${who} have no release note, so a release would close them ${NOTHING_TOLD}. Write a note for each of them first, under Release note on each issue's own page: ${NOTE_HOLDS}.`;
}

/** One issue's missing note, on the gate's row about it or on its own page (`here`), and where it
 *  is written: under Release note on the issue's page, by a member (ISS-1421 r38, judge-155). It
 *  promises no readiness, since the same row can owe its close something too (ISS-1421 r37). */
export function recordMissingForRow(here: boolean): string {
  const where = here ? 'under Release note on this page' : "under Release note on the issue's page";
  return `${here ? 'This issue' : 'It'} has no release note, so a release would close it ${NOTHING_TOLD}, and Release now refuses it. A member of the project writes one ${where}: ${NOTE_HOLDS}.`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** "ISS-1", "ISS-1 and ISS-2", "ISS-1, ISS-2 and ISS-3". */
function namesInWords(ids: string[]): string {
  return ids.length < 2
    ? ids.join('')
    : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

/** A release running, as a person reads it: what it carries, what it waits on, and what the other
 *  waiting issues (`rest`, where the gate lists them) do meanwhile. No abort: no screen offers one,
 *  and the screen links the release's own page beside this (ISS-1421 r38, judge-155). */
function inFlightForReader(details: Details): string {
  const carries = strings(details?.carries);
  const rest = strings(details?.rest);
  const lead =
    carries.length > 0
      ? `A release is already running for this project, carrying ${namesInWords(carries)}.`
      : 'A release is already running for this project.';
  const decision = details?.decision;
  const shown =
    decision && typeof decision === 'object'
      ? (decision as { displayId?: unknown }).displayId
      : undefined;
  const where = typeof shown === 'string' ? `on ${shown}` : "among this project's questions";
  const waits =
    decision && typeof decision === 'object'
      ? ` It is waiting on a decision: its agent stopped on a question ${where}. Answer it in its Decision waiting card and that release goes on.`
      : '';
  const others =
    rest.length > 0
      ? `${namesInWords(rest)} ${agree(rest.length, 'is', 'are')} on no release and ${agree(rest.length, 'waits', 'wait')} until it finishes`
      : 'every other issue waits until it finishes';
  return `${lead}${waits} A project runs one release at a time, so ${others}.`;
}

function runnersForReaderHeld(details: Details): string | null {
  const holds = Array.isArray(details?.runners) ? (details.runners as RunnerHold[]) : [];
  return runnersHeldSentence(holds, runnerHoldReaderClause);
}

/** Not marked merged is the reason, whatever the mark would have named: an issue marked merged with
 *  no commit releases, so "no merge Forge watched land" was never why (ISS-1421 r39, judge-160). */
function unmergedForReader(details: Details): string | null {
  if (!details || !Array.isArray(details.issueIds)) return null;
  const n = details.issueIds.length;
  const w = (one: string, many: string) => agree(n, one, many);
  if (details.shape !== 'outside_git') {
    return `${namedHere(details)} ${w('is', 'are')} not marked merged, so nothing says ${w('its', 'their')} work is on the branch this release deploys. Use Mark merged in ${w("the issue's", "each issue's")} properties first: a release closes what it carries, and a close says the work went out.`;
  }
  return `${namedHere(details)} ${w('has', 'have')} no mark saying where ${w('its', 'their')} work landed. ${w('Its', 'Their')} work lands outside git, so mark ${w('it', 'each one')} merged naming where the work now is — the live URL, CMS entry or storefront resource — first: a release records what went out, and a mark naming nothing does not say that anything did.`;
}

const unreadableDeclarationForReader: RefusedDeclaration = (n) => {
  const w = (one: string, many: string) => agree(n, one, many);
  return `a verify step Forge cannot read: ${w('it names no probe', 'none of them names a probe')} with a url, so no release can be proved ${w('there', 'at any of them')} and none closes past ${w('it', 'them')}. Give ${w('its probe', 'each probe')} a full url, scheme included, or remove ${w('the verify step', 'those verify steps')}, and a release with no probe on any live deploy target is recorded unverified.`;
};

function unreadableForReader(details: Details): string | null {
  if (!Array.isArray(details?.bindings) || details.bindings.length === 0) return null;
  const remedy = releaseBlockerSentence('RELEASE_PROBES_UNREADABLE');
  return unreadableSentence(remedy, details, unreadableDeclarationForReader);
}

/** The labels the live bindings disagree on, named the way the caller's sentence names them. */
function runnersForReader(details: Details): string | null {
  const labels = Array.isArray(details?.labels) ? (details.labels as string[]) : [];
  if (labels.length === 0) return null;
  return `Live deploy targets name ${counted(labels.length, 'different release runner')} (${labels.join(', ')}) — a release is refused rather than sent to whichever was created first. Give them the same label, or retire all but one.`;
}

function unclosableForReader(details: Details): string | null {
  if (!Array.isArray(details?.refused)) return null;
  return unclosableSentence(details.refused as UnclosableIssueRef[], false);
}

/**
 * One entry per code, so a code added later does not type-check until somebody decides what a
 * person reads for it. `CLAIM_CONFLICT`, `RELEASE_CARRIED_DECISION_REFUSED` and
 * `RELEASE_CUT_DROPS_ROSTER` answer a call that named issues or sent decisions, which this screen
 * never makes, so they stay the caller's.
 */
const READER: Record<ReleaseBlockerCode, Reader> = {
  NO_RELEASE_GATE: 'same',
  RELEASE_TARGET_UNDECLARED: 'same',
  CLAIM_CONFLICT: 'same',
  RELEASE_ROSTER_EMPTY: 'same',
  RELEASE_ROSTER_OVERSIZE: 'same',
  RELEASE_RECORD_MISSING: recordMissingForReader,
  RELEASE_WORK_UNMERGED: unmergedForReader,
  RELEASE_ISSUES_UNCLOSABLE: unclosableForReader,
  RELEASE_RUNNER_AMBIGUOUS: runnersForReader,
  RELEASE_PROBES_UNREADABLE: unreadableForReader,
  RELEASE_POOL_EMPTY: 'same',
  NO_RUNNER_ONLINE: runnersForReaderHeld,
  BATCH_IN_FLIGHT: inFlightForReader,
  RELEASE_CRITERIA_UNEARNED: 'same',
  RELEASE_RUNTIME_UNROUTED: 'same',
  RELEASE_CARRIES_UNDECIDED: carriedForReader,
  RELEASE_CARRIED_DECISION_REFUSED: 'same',
  RELEASE_CUT_DROPS_ROSTER: 'same',
  RELEASE_CHECK_UNEVALUATED: uncheckedSentence,
};

/** A reader returning null for these details defers to the caller's sentence. */
export function releaseBlockerReaderSentence(code: ReleaseBlockerCode, details?: Details): string {
  const reader = READER[code];
  const own = reader === 'same' ? null : reader(details);
  return own ?? releaseBlockerSentence(code, details);
}

/** The same split for a warning; only the runner label names a stored field to a caller. */
const WARNING_READER: Record<ReleaseWarningCode, Reader> = {
  RELEASE_ROSTER_IN_PARTS: 'same',
  RELEASE_RUNNER_PREFERENCE_UNMET: (details) =>
    typeof details?.label === 'string'
      ? runnerPreferenceUnmetSentence(details.label, 'the Release runner label')
      : null,
  RELEASE_CRITERIA_HELD_BACK: 'same',
  RELEASE_CRITERIA_UNCORROBORATED: 'same',
  RELEASE_CARRIED_UNREAD: 'same',
};

export type ReaderBlocker = ReleaseBlocker & { reader: string };
export type ReaderWarning = ReleaseWarning & { reader: string };

export function withReader(blocker: ReleaseBlocker): ReaderBlocker {
  return { ...blocker, reader: releaseBlockerReaderSentence(blocker.code, blocker.details) };
}

export function warningWithReader(warning: ReleaseWarning): ReaderWarning {
  const reader = WARNING_READER[warning.code];
  const own = reader === 'same' ? null : reader(warning.details);
  return { ...warning, reader: own ?? warning.message };
}
