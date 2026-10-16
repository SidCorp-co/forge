/**
 * What a person reads on Shape & release for each release reason, beside the sentence a caller
 * reads. Most reasons read alike to both. A reason whose caller sentence names an act only an API
 * caller takes — a flag to read, a field to send, a JSON shape — says the person's act in words
 * instead, the way `statusLabel` and `statusForCaller` split one status (ISS-1229 r8, judge-20).
 */

import type { ReleaseBlockerCode } from '@forge/contracts';
import {
  namedHere,
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
import { agree } from './counted.js';

/** Every check a release reason can stand in for, as a person names the work it does. */
export const RELEASE_CHECK_WORDS = {
  project: "Reading this project's settings",
  knowledge: "Reading this project's written instructions",
  declaration: "Reading this project's release declaration",
  channels: "Reading this project's live deploy bindings",
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

function uncheckedSentence(details: Details): string {
  const check = details?.check;
  const what =
    typeof check === 'string' && Object.hasOwn(RELEASE_CHECK_WORDS, check)
      ? `${RELEASE_CHECK_WORDS[check as ReleaseCheck]} failed`
      : 'One of the checks that decides whether a release may start could not be run';
  const detail =
    typeof details?.detail === 'string' ? ` (${details.detail.replace(/\.$/, '')})` : '';
  return `${what}${detail}, so this answer cannot say whether a release would start: whatever that check would have found is missing from this list, and every other reason here was found by a check that did run. Load this page again to retry it.`;
}

function carriedWaysOutForReader(n: number): string {
  const w = (one: string, many: string) => agree(n, one, many);
  return `${w('It does not', 'None of them')} ship${w('', 's')} until a person decides ${w('it', 'each one')}: when you release, choose Ship unverified, Reverted or Cut below for ${w('it', 'each')} in the Batch release dialog, or bring ${w('it', 'each')} to Awaiting release so the release names it.`;
}

function carriedForReader(details: Details): string | null {
  if (!details || !Array.isArray(details.carried)) {
    return `This release promotes a range that carries the landing of issues nobody put on it. ${carriedWaysOutForReader(2)}`;
  }
  return carriedUndecidedSentence(details, carriedWaysOutForReader);
}

function recordMissingForReader(details: Details): string {
  const n = Array.isArray(details?.issueIds) ? details.issueIds.length : 2;
  const who =
    details && Array.isArray(details.issueIds) ? namedHere(details) : 'The issues named here';
  const w = (one: string, many: string) => agree(n, one, many);
  return `${who} ${w('has', 'have')} no release note, and closing ${w('it', 'them')} would claim a ship nobody wrote anything about. Give ${w('it', 'each')} one first: the one line a user would read, or a note that nothing a user sees changed.`;
}

function unmergedForReader(details: Details): string | null {
  if (details?.shape !== 'outside_git') return null;
  const n = Array.isArray(details.issueIds) ? details.issueIds.length : 0;
  const w = (one: string, many: string) => agree(n, one, many);
  return `${namedHere(details)} ${w('has', 'have')} no mark saying where ${w('its', 'their')} work landed. ${w('Its', 'Their')} work lands outside git, so mark ${w('it', 'each one')} merged naming where the work now is — the live URL, CMS entry or storefront resource — first: a release records what shipped, and a mark naming nothing does not say that anything did.`;
}

const UNREADABLE_DECLARATION_FOR_READER =
  'a verify step Forge cannot read: it names no probe with a url, and a declared verify step takes no project default, so no release can be proved there and none closes past it. Give its probe a full url, scheme included, or remove the verify step: the live commit endpoint recorded for this project then answers, and with neither the release is recorded unverified.';

function unreadableForReader(details: Details): string | null {
  if (!Array.isArray(details?.bindings) || details.bindings.length === 0) return null;
  const remedy = releaseBlockerSentence('RELEASE_PROBES_UNREADABLE');
  return unreadableSentence(remedy, details, UNREADABLE_DECLARATION_FOR_READER);
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
  RELEASE_RUNNER_AMBIGUOUS: 'same',
  RELEASE_PROBES_UNREADABLE: unreadableForReader,
  RELEASE_POOL_EMPTY: 'same',
  NO_RUNNER_ONLINE: 'same',
  BATCH_IN_FLIGHT: 'same',
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
