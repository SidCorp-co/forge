/**
 * The code an operator learns a release refusal by, and the sentence that
 * explains it. Every door reads these, so none carries its own copy (ISS-1127).
 */

import type { ReleaseBlockerCode } from '@forge/contracts';
import { RELEASE_RECORD_REMEDY } from '../issues/release-record-required.js';
import { ISSUE_STATUS_LABELS } from '../issues/status-sets.js';
import type { RunnerHold } from '../runners/ineligible.js';
import type { CarriedCheck, CarriedDecision, CarriedReading } from './carried.js';
import { carriedSentence, carriedWaysOut } from './carried-sentences.js';
import { claimConflictSentence, readClaimConflictDetails } from './claim-conflicts.js';
import { agree, counted } from './counted.js';
import type { ReleaseDeclaration } from './gate.js';
import { criteriaUnearnedLead, unroutedRemedy } from './held-sentences.js';
import type { ReleaseChannel } from './plan.js';
import { RUNNERS_TAB, runnerHoldClause } from './runner-hold-sentences.js';
import type { ServingReading } from './serving-reading.js';
import type { Weighing } from './weighing.js';

export { runnerHoldClause };

/** The most issues one release may carry; `resolveRoster` holds every door to it. */
export const RELEASE_ROSTER_LIMIT = 50;

export type { ReleaseBlockerCode };

export type ReleaseWarningCode =
  | 'RELEASE_ROSTER_IN_PARTS'
  | 'RELEASE_RUNNER_PREFERENCE_UNMET'
  | 'RELEASE_CRITERIA_HELD_BACK'
  | 'RELEASE_CRITERIA_UNCORROBORATED'
  | 'RELEASE_CARRIED_UNREAD';

export type ReleaseReasonCode = ReleaseBlockerCode | ReleaseWarningCode;

export interface ReleaseBlocker {
  code: ReleaseBlockerCode;
  /** 409 where a declaration or roster must change, 503 where the fleet must. */
  httpStatus: 409 | 503;
  message: string;
  details?: Record<string, unknown>;
  /** False only on `RELEASE_CHECK_UNEVALUATED`: this check could not be run. */
  evaluated: boolean;
  /** Set where the answer is about the project's roster, not a named list. */
  scope?: 'roster';
}

/** Something that changes how a release runs without being a reason it will not. */
export interface ReleaseWarning {
  code: ReleaseWarningCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReleaseBlockerReport {
  projectId: string;
  projectExists: boolean;
  /** Null where the project is absent, or where the read failed. */
  declaration: ReleaseDeclaration | null;
  /** Distinct from a project that declares none: `[]` is an answer. */
  channels: ReleaseChannel[] | null;
  blockers: ReleaseBlocker[];
  warnings: ReleaseWarning[];
  /** What the release's range carries beyond its roster, where a reading was passed (ISS-1386). */
  carried?: CarriedCheck | undefined;
}

export type ReleaseDoor = 'batch' | 'record';

export interface CollectReleaseBlockersOptions {
  /** The issues this call names. Omitted, the project's whole roster is read. */
  issueIds?: string[] | undefined;
  door?: ReleaseDoor | undefined;
  /** Read by the CALLER — this enumerator reaches no network; without one the criteria check
   *  reports itself unevaluated rather than guess (ISS-1286). */
  serving?: ServingReading | undefined;
  /** Read beside `serving` (ISS-1368), or why it failed; absent, equality alone weighs a verdict. */
  weighing?: Weighing | string | undefined;
  /** The release range, read by the caller (ISS-1386); absent, the batch door judges no range. */
  carried?: CarriedReading | undefined;
  /** What the caller decided for each issue that range carries off the roster. */
  decisions?: readonly CarriedDecision[] | undefined;
}

/**
 * An error carrying every reason that stood when it was thrown. The first
 * blocker keeps its class, code and wording; the rest ride along, which is the
 * whole of ISS-1127.
 */
export type ReleaseBlockedError = Error & { releaseBlockers?: ReleaseBlocker[] };

export function blockersOf(err: unknown): ReleaseBlocker[] {
  const carried = (err as ReleaseBlockedError | null)?.releaseBlockers;
  return Array.isArray(carried) ? carried : [];
}

/** The reasons standing beside the one being thrown, for a refusal body. */
export function alsoBlocking(err: unknown, thrown: ReleaseBlockerCode): ReleaseBlocker[] {
  // Only the FIRST match goes: two checks can fail to evaluate.
  const rest = [...blockersOf(err)];
  const at = rest.findIndex((b) => b.code === thrown);
  if (at >= 0) rest.splice(at, 1);
  return rest;
}

type NamedCode =
  | 'CLAIM_CONFLICT'
  | 'RELEASE_RECORD_MISSING'
  | 'RELEASE_WORK_UNMERGED'
  | 'RELEASE_ISSUES_UNCLOSABLE';

/** A refusal about issues the call named, in the number it names; with none read, it counts none. */
const NAMED_CODES = new Set<string>([
  'CLAIM_CONFLICT',
  'RELEASE_RECORD_MISSING',
  'RELEASE_WORK_UNMERGED',
  'RELEASE_ISSUES_UNCLOSABLE',
]);

function isNamedCode(code: ReleaseBlockerCode): code is NamedCode {
  return NAMED_CODES.has(code);
}

function namedSentence(code: NamedCode, details: Record<string, unknown> | null): string {
  const n = details && Array.isArray(details.issueIds) ? details.issueIds.length : null;
  const who = n === null ? 'The issues named here' : namedHere(details as Record<string, unknown>);
  const w = (one: string, many: string) => agree(n ?? 2, one, many);
  switch (code) {
    case 'CLAIM_CONFLICT':
      return `${who} ${w('is', 'are')} not at the release gate, ${w('is', 'are')} not on this project, or ${w('is', 'are')} already claimed by a batch. Read the roster and send the issues it lists.`;
    case 'RELEASE_RECORD_MISSING':
      return `${who} ${w('has', 'have')} no release note, and closing ${w('it', 'them')} would claim a ship nobody wrote anything about. ${RELEASE_RECORD_REMEDY}`;
    case 'RELEASE_WORK_UNMERGED':
      return `${who} ${w('has', 'have')} no merge Forge watched land, so nothing says ${w('its', 'their')} work is on the branch this release deployed. Mark the merge on ${w('it', 'each of them')} first — a release records what shipped, and an issue nobody merged did not.`;
    case 'RELEASE_ISSUES_UNCLOSABLE':
      return `${who} would be refused ${w('its', 'their')} close when this release finishes, so it would release ${w('it', 'them')} and hand ${w('it', 'them')} back to the gate. Clear what ${w('it is', 'each one is')} refused for, or leave ${w('it', 'each')} off this release.`;
  }
}

const REMEDY: Record<ReleaseBlockerCode, string> = {
  NO_RELEASE_GATE:
    'This project has no release step, so Forge has no release to start or record: here, closing an issue is what ships it. To release through Forge instead, declare a release chain under Settings → Shape & release and give it a live deploy binding under Settings → Integrations.',
  RELEASE_TARGET_UNDECLARED:
    'This project declares a release chain and has no active deploy binding carrying the `live` stage, so there is nowhere for a release to land. Add one on the integrations screen, or, if this project ships nothing, choose "Repository, no release" under Shape & release in its settings.',
  CLAIM_CONFLICT: namedSentence('CLAIM_CONFLICT', null),
  RELEASE_ROSTER_EMPTY: `Nothing is ready to release: no issue is at ${ISSUE_STATUS_LABELS.awaiting_release}.`,
  RELEASE_ROSTER_OVERSIZE: `More issues are waiting than one release may carry. A release names at most ${RELEASE_ROSTER_LIMIT} issues, so cut this roster in parts, oldest merge first.`,
  RELEASE_RECORD_MISSING: namedSentence('RELEASE_RECORD_MISSING', null),
  RELEASE_WORK_UNMERGED: namedSentence('RELEASE_WORK_UNMERGED', null),
  RELEASE_ISSUES_UNCLOSABLE: namedSentence('RELEASE_ISSUES_UNCLOSABLE', null),
  RELEASE_RUNNER_AMBIGUOUS:
    'Live deploy bindings name different release runners, so there is no one box the release job may be offered to. Make the labels agree, or clear all but one.',
  RELEASE_PROBES_UNREADABLE:
    'A declared verification probe holds a url that is not a url, so no request could ever be made to it and the release would fail while reading what production is serving. Correct the probe, including its scheme.',
  RELEASE_POOL_EMPTY:
    'This project has no runner registered, so there is no box a release could run on. Pair a box to this project first.',
  NO_RUNNER_ONLINE:
    'This project has runners registered and none of them could be handed a release, and the reading of why could not be taken. Open Settings \u2192 Runners and check each box\'s "Takes jobs from the pool" switch and when it was last seen.',
  BATCH_IN_FLIGHT:
    'A release is already running for this project, and a second one would claim the same issues. Let it finish, or abort it with what you found.',
  RELEASE_CRITERIA_UNEARNED: `${criteriaUnearnedLead(0)}.`,
  RELEASE_RUNTIME_UNROUTED: unroutedRemedy(0),
  RELEASE_CARRIES_UNDECIDED: `This release promotes a range that carries the landing of issues this batch does not name. ${carriedWaysOut(2)}`,
  RELEASE_CARRIED_DECISION_REFUSED:
    'A decision sent with this batch for an issue its range carries does not hold. Correct each one named and send the batch again.',
  RELEASE_CUT_DROPS_ROSTER:
    'A `cut-below` moves the release below the landing of issues this batch names, so it would name issues it does not ship. Take them off the roster, or decide the carried issue another way.',
  RELEASE_CHECK_UNEVALUATED:
    'One of the checks that decides whether a release may start could not be run, so this answer cannot say a release would succeed: whatever that check would have found is missing from this list. Every other reason here was reached by a check of its own — act on the ones carrying `evaluated: true`, and retry EVERY entry shaped like this one, each naming the read of its own that has to answer first.',
};

/**
 * An act a remedy names, and the reason taking it raises. `raises` is ONE code:
 * an act whose consequence depends on state cannot be told to an operator, so it
 * is not an act to put in a remedy at all (ISS-1127).
 */
export interface RemedyAct {
  /** Worded so `remedyCostClause` reads as one sentence with it. */
  act: string;
  /** Stems, ANY one naming this act; a false positive is the cheaper error. */
  worded: readonly string[];
  raises: ReleaseReasonCode;
}

/** Over both unions, so a code added later cannot skip the question. */
export const REMEDY_COST: Record<ReleaseReasonCode, readonly RemedyAct[]> = {
  NO_RELEASE_GATE: [],
  RELEASE_TARGET_UNDECLARED: [],
  CLAIM_CONFLICT: [],
  RELEASE_ROSTER_EMPTY: [],
  RELEASE_ROSTER_OVERSIZE: [],
  RELEASE_RECORD_MISSING: [],
  RELEASE_WORK_UNMERGED: [],
  RELEASE_ISSUES_UNCLOSABLE: [],
  RELEASE_RUNNER_AMBIGUOUS: [],
  RELEASE_PROBES_UNREADABLE: [],
  RELEASE_POOL_EMPTY: [],
  NO_RUNNER_ONLINE: [],
  BATCH_IN_FLIGHT: [],
  RELEASE_CRITERIA_UNEARNED: [],
  RELEASE_RUNTIME_UNROUTED: [],
  RELEASE_CARRIES_UNDECIDED: [],
  RELEASE_CARRIED_DECISION_REFUSED: [],
  RELEASE_CUT_DROPS_ROSTER: [],
  RELEASE_CHECK_UNEVALUATED: [],
  RELEASE_ROSTER_IN_PARTS: [],
  RELEASE_RUNNER_PREFERENCE_UNMET: [],
  RELEASE_CRITERIA_HELD_BACK: [],
  RELEASE_CRITERIA_UNCORROBORATED: [],
  RELEASE_CARRIED_UNREAD: [],
};

export function remedyCostClause(cost: RemedyAct): string {
  return `${cost.act} raises \`${cost.raises}\`, which does stop a release until it is answered.`;
}

function withCosts(code: ReleaseReasonCode, sentence: string): string {
  const costs = REMEDY_COST[code];
  return costs.length === 0 ? sentence : [sentence, ...costs.map(remedyCostClause)].join(' ');
}

/** One owner, so no two doors disagree about whose problem a reason is. */
export function blockerHttpStatus(code: ReleaseBlockerCode): 409 | 503 {
  return code === 'RELEASE_POOL_EMPTY' ||
    code === 'NO_RUNNER_ONLINE' ||
    code === 'RELEASE_CHECK_UNEVALUATED'
    ? 503
    : 409;
}

/** One issue the release sweep will not carry, and what it still owes. */
export interface HeldIssueRef {
  /** The uuid, which the api and a follow-up call need and no screen shows. */
  issueId: string;
  /** `ISS-nn` — what the issue list, the header and the url call it. */
  displayId: string;
  criteria: number[];
}

const INTEGRATIONS_TAB = 'Settings → Integrations';
const CONNECTIONS_DIRECTORY = 'Integrations in the workspace rail';

function runnersHeldSentence(holds: RunnerHold[]): string | null {
  if (holds.length === 0) return null;
  const can = agree(holds.length, 'it cannot', 'not one of them can');
  const head = `This project has ${counted(holds.length, 'runner')} registered and ${can} take a release right now.`;
  return `${head} ${holds.map(runnerHoldClause).join(' ')}`;
}

/** The act that makes the repository readable, once, ahead of the verdicts it lets be weighed. */
function readableFirst(clears: readonly string[], subject: 'this' | 'that'): string {
  return `A person clears ${subject} by making the repository readable: ${clears.join('; and ')}. The next sweep then weighs every waiting issue again.`;
}

/** One sentence in the screen's words; the link beside it opens the issues. Which issue owes which
 *  criterion rides along for a caller with no link. A failed repository read leads with its own
 *  act, because no verdict and no link repairs it (ISS-1398 judge j3). */
function criteriaUnearnedSentence(held: HeldIssueRef[], clears: readonly string[]): string {
  const owed = held.length === 0 ? '' : `: ${owesList(held)}`;
  const unread =
    clears.length === 0
      ? ''
      : `At least one acceptance criterion cannot be weighed until the repository can be read: ${clears.join('; and ')}. `;
  return `${unread}${criteriaUnearnedLead(held.length)}${owed}.`;
}

/** "criterion 4", "criteria 1–30", "criteria 3, 7 and 9–12". */
function criteriaPhrase(criteria: readonly number[]): string {
  const nums = [...new Set(criteria)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === (nums[j] as number) + 1) j++;
    runs.push(j - i >= 2 ? `${nums[i]}–${nums[j]}` : nums.slice(i, j + 1).join(', '));
    i = j + 1;
  }
  const listed = runs.join(', ').replace(/, ([^,]*)$/, ' and $1');
  return nums.length === 1 ? `criterion ${listed}` : `criteria ${listed}`;
}

function owesList(held: HeldIssueRef[]): string {
  return held.map((h) => `\`${h.displayId}\` owes ${criteriaPhrase(h.criteria)}`).join('; ');
}

function heldIssuesSentence(remedy: string, held: HeldIssueRef[]): string {
  return `${remedy} ${owesList(held)}.`;
}

const {
  testing: TESTING,
  tested: TESTED,
  awaiting_release: AWAITING_RELEASE,
} = ISSUE_STATUS_LABELS;

function nearGateSentence(nearGate: number): string {
  if (nearGate === 0) {
    return `Nothing is ready to release: no issue is at ${TESTING}, ${TESTED} or ${AWAITING_RELEASE}.`;
  }
  const issues = `${counted(nearGate, 'issue')} ${agree(nearGate, 'is', 'are')}`;
  return `Nothing is ready to release: ${issues} at ${TESTING} or ${TESTED}, and ${agree(nearGate, 'it', 'each')} moves to ${AWAITING_RELEASE} once it records where its change now runs.`;
}

/**
 * The sentence for this code, composed from what the check actually resolved.
 *
 * A code reads its details rather than printing its literal where the literal could only
 * describe one of the states that reach it; every other code prints its literal.
 */
export function releaseBlockerSentence(
  code: ReleaseBlockerCode,
  details?: Record<string, unknown>,
): string {
  return withCosts(code, sentenceFor(code, details));
}

function sentenceFor(code: ReleaseBlockerCode, details?: Record<string, unknown>): string {
  const remedy = REMEDY[code];
  if (code === 'NO_RUNNER_ONLINE') {
    const holds = (details?.runners as RunnerHold[] | undefined) ?? [];
    return runnersHeldSentence(holds) ?? remedy;
  }
  if (code === 'BATCH_IN_FLIGHT' && details?.decision && typeof details.decision === 'object') {
    return waitingOnDecisionSentence((details.decision as { displayId?: string | null }).displayId);
  }
  if (code === 'RELEASE_ROSTER_EMPTY' && typeof details?.nearGate === 'number') {
    return nearGateSentence(details.nearGate);
  }
  if (code === 'RELEASE_CRITERIA_UNEARNED') {
    const held = (details?.held as HeldIssueRef[] | undefined) ?? [];
    const clears = (details?.clears as string[] | undefined) ?? [];
    return criteriaUnearnedSentence(held, clears);
  }
  const carried = carriedSentence(code, details);
  if (carried) return carried;
  if (code === 'RELEASE_RUNTIME_UNROUTED' && typeof details?.missing === 'string') {
    return unroutedSentence(details.missing, details);
  }
  if (code === 'RELEASE_WORK_UNMERGED' && details?.shape === 'outside_git') {
    const n = Array.isArray(details.issueIds) ? details.issueIds.length : 0;
    return `${namedHere(details)} ${agree(n, 'has', 'have')} no mark saying where ${agree(n, 'its', 'their')} work landed. ${agree(n, 'Its', 'Their')} work lands outside git, so mark ${agree(n, 'it', 'each one')} merged with its \`landing\` — the live URL, CMS entry or storefront resource the work now is — first: a release records what shipped, and a mark naming nothing does not say that anything did.`;
  }
  if (code === 'RELEASE_ISSUES_UNCLOSABLE' && Array.isArray(details?.refused)) {
    return unclosableSentence(details.refused as UnclosableIssueRef[]);
  }
  if (code === 'RELEASE_TARGET_UNDECLARED' && Array.isArray(details?.releaseChain)) {
    const chain = details.releaseChain as { branch?: unknown }[];
    const last = chain[chain.length - 1]?.branch;
    return `This project's release chain ends at \`${String(last)}\` and it has no active deploy binding carrying the \`live\` stage, so there is nowhere for a release to land. Add one on the integrations screen, or, if this project ships nothing, choose "Repository, no release" under Shape & release in its settings.`;
  }
  if (
    code === 'RELEASE_RUNNER_AMBIGUOUS' &&
    Array.isArray(details?.labels) &&
    details.labels.length > 0
  ) {
    const labels = details.labels as string[];
    return `Live deploy bindings name ${counted(labels.length, 'different release runner')} (${labels.join(', ')}), so there is no one box the release job may be offered to. Make the labels agree, or clear all but one.`;
  }
  const standings = code === 'CLAIM_CONFLICT' ? readClaimConflictDetails(details) : null;
  if (standings) {
    return claimConflictSentence(standings.projectId, standings.gateStatus, standings.conflicts);
  }
  if (Array.isArray(details?.issueIds) && isNamedCode(code)) return namedSentence(code, details);
  if (code === 'RELEASE_PROBES_UNREADABLE') return unreadableSentence(remedy, details);
  const urls = details?.urls;
  if (Array.isArray(urls) && urls.length > 0) return `${quoted(urls)} — ${remedy}`;
  const check = details?.check;
  if (typeof check === 'string') {
    // The reading's own reason, which is the one thing a person can act on (ISS-1386 r2).
    const detail =
      typeof details?.detail === 'string' ? `: ${details.detail.replace(/\.$/, '')}` : '';
    return `The \`${check}\` check could not be run${detail}. ${remedy}`;
  }
  const waiting = details?.waiting;
  if (typeof waiting === 'number') return `${waiting} waiting. ${remedy}`;
  return remedy;
}

/** A release already in flight that is held on a person's answer, and where the answer is owed. */
function waitingOnDecisionSentence(displayId: string | null | undefined): string {
  const where = displayId ? `open on \`${displayId}\`` : "open among this project's questions";
  return `A release is already running for this project and is waiting on a decision: its agent stopped on a question, ${where}. Answer it there and that release goes on; or abort it with what you found. A second release would claim the same issues, so it is not started.`;
}

/** The warning a promote chain with no route to read its repository gets instead; `why`, last and on
 *  a line of its own, says which route to declare, in the words of the host its URL names. */
export function carriedUnreadWarningSentence(why: string): string {
  const said = withCosts(
    'RELEASE_CARRIED_UNREAD',
    'This project promotes a branch onto production, and Forge has no route to read its repository. ' +
      'So it could not read which landings this release carries beyond the issues it names. ' +
      'Once it can, every release names each issue its range carries.',
  );
  return `${said}\n${why.trim()}`;
}

/** One issue the finish's close would refuse, as `RELEASE_ISSUES_UNCLOSABLE` carries it. */
export interface UnclosableIssueRef {
  issueId: string;
  displayId: string;
  shortfalls: Array<{ code: string; reason: string; clears: string }>;
}

/** `codes` is false for a person, who acts on the reason and has no use for the code it is filed under. */
export function unclosableSentence(refused: readonly UnclosableIssueRef[], codes = true): string {
  const reason = (s: UnclosableIssueRef['shortfalls'][number]) =>
    codes ? `${s.reason} (${s.code}): ${s.clears}` : `${s.reason}: ${s.clears}`;
  const each = refused
    .map((r) => `\`${r.displayId}\` ${r.shortfalls.map(reason).join(' ')}`)
    .join(' ');
  const n = refused.length;
  const w = (one: string, many: string) => agree(n, one, many);
  const reasons = refused.reduce((sum, r) => sum + r.shortfalls.length, 0);
  return `${counted(n, 'issue')} named here would be refused ${w('its', 'their')} close when this release finishes, so it would release ${w('it', 'them')} and hand ${w('it', 'them')} back to the gate. ${each} Clear ${agree(reasons, 'that', 'each')} reason, or leave ${w('it', 'each such issue')} off this release.`;
}

export function namedHere(details: Record<string, unknown>): string {
  const ids = Array.isArray(details.issueIds) ? details.issueIds : [];
  const shown = Array.isArray(details.displayIds) ? (details.displayIds as string[]) : [];
  const which = shown.length === 0 ? '' : ` (${shown.map((id) => `\`${id}\``).join(', ')})`;
  return `${counted(ids.length, 'issue')} named here${which}`;
}

/** The route comes off the project's own bindings, never a provider it cannot become (ISS-1346). */
function unroutedSentence(missing: string, details: Record<string, unknown>): string {
  const route =
    typeof details.route === 'string' ? ` The way to give it one: ${details.route}.` : '';
  const held = (details.held as HeldIssueRef[] | undefined) ?? [];
  const lead = `${unroutedRemedy(held.length)} What is missing: ${missing}.${route}`;
  return held.length === 0 ? lead : heldIssuesSentence(lead, held);
}

/** What follows the bindings a refused `verify` names, agreeing with how many there are. */
export type RefusedDeclaration = (bindings: number) => string;

/** A `verify` Forge refused takes no project default, so removing it is a repair and not silence. */
const refusedDeclarationSentence: RefusedDeclaration = (n) => {
  const w = (one: string, many: string) => agree(n, one, many);
  return `a \`verify\` Forge cannot read — ${w('it names no probe', 'none of them names a probe')} with a url — and a declared \`verify\` takes NO project default, so no release can be proved ${w('there', 'at any of them')} and none closes past ${w('it', 'them')}. Correct ${w('it', 'each')} to \`{"probes":[{"url":"https://<host>/api/health","commitPath":"commit"}]}\`, or remove ${w('it', 'them')}: the project's \`environments.live.commitUrl\` then answers, and with neither the release is recorded unverified.`;
};

/** Urls as code, so a sentence that opens on one reads the same wherever it is answered. */
function quoted(urls: readonly unknown[]): string {
  return urls.map((u) => `\`${String(u)}\``).join(', ');
}

/** The probes whose url is not a url, counted, since the remedy alone speaks of one. */
function unreadableUrls(n: number): string {
  const w = (one: string, many: string) => agree(n, one, many);
  return `${w('A declared verification probe holds a url that is', `${n} declared verification probes hold urls that are`)} not ${w('a url', 'urls')}, so no request could ever be made to ${w('it', 'them')} and the release would fail while reading what production is serving. Correct ${w('the probe', 'each probe')}, including its scheme.`;
}

export function unreadableSentence(
  remedy: string,
  details?: Record<string, unknown>,
  refused: RefusedDeclaration = refusedDeclarationSentence,
): string {
  const urls = Array.isArray(details?.urls) ? (details.urls as string[]) : [];
  const bindings = Array.isArray(details?.bindings) ? (details.bindings as string[]) : [];
  const parts: string[] = [];
  if (urls.length > 0) parts.push(`${quoted(urls)} — ${unreadableUrls(urls.length)}`);
  if (bindings.length > 0) {
    const which = bindings.map((b) => `\`${b}\``).join(', ');
    const w = (one: string, many: string) => agree(bindings.length, one, many);
    parts.push(
      `The live deploy ${w('binding', 'bindings')} ${which} ${w('declares', 'each declare')} ${refused(bindings.length)}`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : remedy;
}

/** The sweep is cutting a release and leaving these behind, which stops nothing. */
export function uncorroboratedWarningSentence(held: HeldIssueRef[], why: string): string {
  const issues = `${counted(held.length, 'issue')} ${agree(held.length, 'carries', 'carry')}`;
  const each = held.map((h) => `\`${h.displayId}\` on ${criteriaPhrase(h.criteria)}`).join('; ');
  return withCosts(
    'RELEASE_CRITERIA_UNCORROBORATED',
    `${issues} a criterion earned at a runtime nothing here could re-read: ${why} Those verdicts count — absence of a reading is not a failure — and they are weaker evidence than a reading would have made them. Whether each issue ships is decided by its own criteria, not by this. ${each}.`,
  );
}

/** Where nothing can read what the project serves, no judging run earns a criterion, so the remedy
 *  is the project's route and not a verdict (ISS-1346, judge r2 finding 1). */
export function heldBackWarningSentence(
  held: HeldIssueRef[],
  serving: ServingReading,
  clears: readonly string[] = [],
): string {
  const lead = `A release will still be cut, without ${counted(held.length, 'issue')} the sweep is holding back`;
  const each = agree(held.length, 'it', 'each');
  const why =
    serving.kind === 'undeclared'
      ? `${lead}: ${each} owes an acceptance criterion, and nothing here can read what this project is serving, so no judging run can earn one until the project can be read. What is missing: ${serving.missing}. The way to give it one: ${serving.route}.`
      : clears.length > 0
        ? `${lead}: ${each} still owes an acceptance criterion, and at least one could not be weighed because the repository could not be read. ${readableFirst(clears, 'that')} Otherwise ${each} stays at the gate until a judging run earns it.`
        : `${lead}: ${each} still owes a judging run on an acceptance criterion, and stays at the gate until it is earned.`;
  return withCosts('RELEASE_CRITERIA_HELD_BACK', heldIssuesSentence(why, held));
}

/** The sweep cuts an over-cap roster in parts, so there is nothing here for a person to cut (ISS-1360). */
export function rosterInPartsWarningSentence(waiting: number, part: number, later: number): string {
  const text = `${waiting} issues are waiting at the release gate and one release carries at most ${RELEASE_ROSTER_LIMIT}. This project releases without a person acting, so the automatic sweep cuts them in parts, the oldest merge first, setting aside any it is holding back: this answer is judged on the oldest ${part}, and the remaining ${later} ${agree(later, 'waits', 'wait')} for a later release. Nothing here is for a person to cut.`;
  return withCosts('RELEASE_ROSTER_IN_PARTS', text);
}

/** The declared release label no box carries. Here, not at the call site: this module owns every
 *  sentence a door prints (ISS-1127). Each act names the screen it is taken on, the free one
 *  having been offered for a round with none. The label matches `runners.labels`, the box a
 *  release RUNS on, not the one holding the deploy credential — on Coolify, Forge (ISS-1275). */
export function runnerPreferenceUnmetSentence(
  label: string,
  field = '`releaseRunnerLabel`',
): string {
  return withCosts(
    'RELEASE_RUNNER_PREFERENCE_UNMET',
    `No box carries the release label \`${label}\`, so this release goes to the pool this project has. Label the box you want this project's releases to run on with \`${label}\` under ${RUNNERS_TAB}. Or clear ${field} from the live deploy binding under ${INTEGRATIONS_TAB} and from the connection behind it under ${CONNECTIONS_DIRECTORY}, since the binding falls back to it. Either one is complete, and this warning goes with the label.`,
  );
}
