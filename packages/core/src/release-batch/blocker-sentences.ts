/**
 * The code an operator learns a release refusal by, and the sentence that
 * explains it. Every door reads these, so none carries its own copy (ISS-1127).
 */

import { RELEASE_RECORD_REMEDY } from '../issues/release-record-required.js';
import { AGENT_NAMING_MIN_RUNNER } from '../runners/device-cap.js';
import type { RunnerHold, RunnerHoldReason } from '../runners/ineligible.js';
import type { CarriedCheck, CarriedDecision, CarriedReading } from './carried.js';
import { claimConflictSentence, readClaimConflictDetails } from './claim-conflicts.js';
import type { ReleaseDeclaration } from './gate.js';
import type { ReleaseChannel } from './plan.js';
import type { ServingReading } from './serving-reading.js';
import type { Weighing } from './weighing.js';

/** The most issues one release may carry; `resolveRoster` holds every door to it. */
export const RELEASE_ROSTER_LIMIT = 50;

export type ReleaseBlockerCode =
  | 'NO_RELEASE_GATE'
  | 'RELEASE_TARGET_UNDECLARED'
  | 'CLAIM_CONFLICT'
  | 'RELEASE_ROSTER_EMPTY'
  | 'RELEASE_ROSTER_OVERSIZE'
  | 'RELEASE_RECORD_MISSING'
  | 'RELEASE_WORK_UNMERGED'
  | 'RELEASE_ISSUES_UNCLOSABLE'
  | 'RELEASE_RUNNER_AMBIGUOUS'
  | 'RELEASE_PROBES_UNREADABLE'
  | 'RELEASE_POOL_EMPTY'
  | 'NO_RUNNER_ONLINE'
  | 'BATCH_IN_FLIGHT'
  | 'RELEASE_CRITERIA_UNEARNED'
  | 'RELEASE_RUNTIME_UNROUTED'
  | 'RELEASE_CARRIES_UNDECIDED'
  | 'RELEASE_CARRIED_DECISION_REFUSED'
  | 'RELEASE_CUT_DROPS_ROSTER'
  | 'RELEASE_CHECK_UNEVALUATED';

export type ReleaseWarningCode =
  | 'RELEASE_RUNNER_PREFERENCE_UNMET'
  | 'RELEASE_CRITERIA_HELD_BACK'
  | 'RELEASE_CRITERIA_UNCORROBORATED'
  | 'RELEASE_CARRIED_UNREAD';

/** Every reason this project answers with, whether or not it stops a release. */
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

const CARRIED_WAYS_OUT =
  'None of them ships without a decision. Send one per issue with the batch: `ship-unverified` with what is unverified; `revert` once its landing is reverted on the branch being promoted; or `cut-below`, which releases only what landed before it. Or move the issue to the release gate and name it on the roster.';

const REMEDY: Record<ReleaseBlockerCode, string> = {
  NO_RELEASE_GATE:
    'This project has no release step, so Forge has no release to start or record: here, closing an issue is what ships it. Close these issues to ship them. To release through Forge instead, declare a release chain under Settings → Repository and give it a live deploy binding under Settings → Integrations.',
  RELEASE_TARGET_UNDECLARED:
    'This project declares a release chain and has no active deploy binding carrying the `live` stage, so there is nowhere for a release to land. Add one on the integrations screen, or, if this project ships nothing, press "This project ships nothing" on its Repository settings tab.',
  CLAIM_CONFLICT:
    '{n} issue(s) named here are not at the release gate, are not on this project, or are already claimed by a batch. Read the roster and send the issues it lists.',
  RELEASE_ROSTER_EMPTY:
    'Nothing is waiting at the release gate, so there is no release to cut. An issue reaches it by moving to `awaiting_release`, which is an act of its own.',
  RELEASE_ROSTER_OVERSIZE: `More issues are waiting than one release may carry. A release names at most ${RELEASE_ROSTER_LIMIT} issues, so cut this roster in parts, oldest merge first.`,
  RELEASE_RECORD_MISSING:
    '{n} issue(s) named here have no release note, and closing them would claim a ship ' +
    `nobody wrote anything about. ${RELEASE_RECORD_REMEDY}`,
  RELEASE_WORK_UNMERGED:
    '{n} issue(s) named here have no merge Forge watched land, so nothing says their work is on the branch this release deployed. Mark the merge on each of them first — a release records what shipped, and an issue nobody merged did not.',
  RELEASE_ISSUES_UNCLOSABLE:
    '{n} issue(s) named here would be refused their close when this release finishes, so it would release them and hand them back to the gate. Clear what each one is refused for, or leave it off this release.',
  RELEASE_RUNNER_AMBIGUOUS:
    'Two live deploy bindings name different release runners, so there is no one box the release job may be offered to. Make the labels agree, or clear all but one.',
  RELEASE_PROBES_UNREADABLE:
    'A declared verification probe holds a url that is not a url, so no request could ever be made to it and the release would fail while reading what production is serving. Correct the probe, including its scheme.',
  RELEASE_POOL_EMPTY:
    'This project has no runner registered, so there is no box a release could run on. Pair a box to this project first.',
  NO_RUNNER_ONLINE:
    'This project has runners registered and none of them could be handed a release, and the reading of why could not be taken. Open Settings \u2192 Runners and check each box\'s "Takes jobs from the pool" switch and when it was last seen.',
  BATCH_IN_FLIGHT:
    'A release is already running for this project, and a second one would claim the same issues. Let it finish, or abort it with what you found.',
  RELEASE_CRITERIA_UNEARNED:
    'This project releases without a person acting, and the sweep that cuts its releases is holding back every issue waiting at the gate: each still owes a judging run on an acceptance criterion. Record a verdict for each criterion named below, or move the issue out of `awaiting_release` if it is not to ship.',
  RELEASE_RUNTIME_UNROUTED:
    'This project releases without a person acting, only an issue whose every acceptance criterion is earned at what it is serving, and nothing here can read what it is serving — so no verdict a run records can earn one, and every issue waiting at the gate is held on that one reason. Give it a way to be read, and the next sweep weighs every waiting issue again.',
  RELEASE_CARRIES_UNDECIDED: `This release promotes a range that carries the landing of issues this batch does not name. ${CARRIED_WAYS_OUT}`,
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

const RUNNERS_TAB = 'Settings → Runners';
const INTEGRATIONS_TAB = 'Settings → Integrations';
const CONNECTIONS_DIRECTORY = 'Integrations in the workspace rail';

/**
 * What clears this reading, per reading. Every one of them answers: a reading with no
 * act is correct about the state and silent about what to do with it. Where nobody can
 * act — a rate limit, a quarantine, a provision in flight — the clause says what is
 * being waited out and until when, which is an answer too (ISS-1127).
 */
const RUNNER_HOLD_ACT: Record<RunnerHoldReason, (hold: RunnerHold) => string> = {
  'device-disabled': () =>
    `sits on a device an operator has turned off. Re-enable that device under ${RUNNERS_TAB} before this box can take anything.`,
  retired: (h) =>
    `is \`${h.detail ?? 'draining'}\` and so takes nothing from the pool. Switch "Takes jobs from the pool" back on for it under ${RUNNERS_TAB}.`,
  'never-connected': () =>
    'is registered and has never reported in. Start `forge-runner` on that box.',
  disconnected: () =>
    'reported itself offline. Start `forge-runner` on that box, or wait for it to reconnect.',
  stale: () => 'has stopped reporting. Check `forge-runner` is still running on that box.',
  auth: () =>
    `had its agent credential rejected, so it is taking nothing. Re-authenticate the agent on that box; ${RUNNERS_TAB} shows the detail it reported.`,
  'rate-limited': (h) =>
    `is rate limited until ${h.detail ?? 'it clears'}. Nothing here clears it sooner — wait it out, or bring another box up.`,
  quarantined: (h) =>
    `is quarantined until ${h.detail ?? 'it clears'} after repeated failures. Wait it out, or clear the quarantine under ${RUNNERS_TAB}.`,
  provisioning: (h) =>
    `has not finished provisioning its workspace (\`${h.detail ?? 'in progress'}\`). Watch it under ${RUNNERS_TAB}; a provision that is stuck is re-run from there.`,
  'below-floor': (h) =>
    `runs agent version ${h.detail ?? 'unreported'}, below the ${AGENT_NAMING_MIN_RUNNER} a claim needs. Upgrade \`forge-runner\` on that box.`,
};

/** Readings whose own words already say when the box last reported. */
const HOLD_STATES_ITS_OWN_AGE: ReadonlySet<RunnerHoldReason> = new Set([
  'never-connected',
  'disconnected',
  'stale',
]);

function lastSeenPhrase(hold: RunnerHold): string {
  if (hold.lastSeenSeconds === null) return ' It has never reported.';
  const ago = `${hold.lastSeenSeconds}s ago`;
  return hold.reporting
    ? ` It is up and reporting, last seen ${ago}.`
    : ` It last reported ${ago}.`;
}

export function runnerHoldClause(hold: RunnerHold): string {
  const act = RUNNER_HOLD_ACT[hold.reason](hold);
  const age = HOLD_STATES_ITS_OWN_AGE.has(hold.reason)
    ? hold.lastSeenSeconds === null
      ? ''
      : ` Last seen ${hold.lastSeenSeconds}s ago.`
    : lastSeenPhrase(hold);
  return `\`${hold.deviceName}\` ${act}${age}`;
}

function runnersHeldSentence(holds: RunnerHold[]): string | null {
  if (holds.length === 0) return null;
  const count = `${holds.length} runner${holds.length === 1 ? '' : 's'}`;
  const head = `This project has ${count} registered and not one of them can take a release right now.`;
  return `${head} ${holds.map(runnerHoldClause).join(' ')}`;
}

/** The act that makes the repository readable, once, ahead of the verdicts it lets be weighed. */
function readableFirst(clears: readonly string[], subject: 'this' | 'that'): string {
  return `A person clears ${subject} by making the repository readable: ${clears.join('; and ')}. The next sweep then weighs every waiting issue again.`;
}

function criteriaUnreadSentence(clears: readonly string[]): string {
  return `This project releases without a person acting, and the sweep that cuts its releases is holding back every issue waiting at the gate: each still owes an acceptance criterion, and at least one could not be weighed because the repository could not be read. ${readableFirst(clears, 'this')} Otherwise, record a verdict for each criterion named below, or move the issue out of \`awaiting_release\` if it is not to ship.`;
}

function heldIssuesSentence(remedy: string, held: HeldIssueRef[]): string {
  const each = held
    .map((h) => `\`${h.displayId}\` owes criterion ${h.criteria.join(', ')}`)
    .join('; ');
  return `${remedy} ${each}.`;
}

const NEAR_GATE_ACT =
  'An issue moves there once its own record earns it: the verification naming where the ' +
  'change now runs, at which commit and on what evidence, plus the release note where one ' +
  "is owed. With those written, the issue's own status control makes the move.";

function nearGateSentence(nearGate: number): string {
  if (nearGate === 0) {
    return `Nothing is waiting at the release gate, and nothing stands one move short of it: no issue on this project is at \`testing\` or at \`tested\`. An issue reaches the gate at \`awaiting_release\`. ${NEAR_GATE_ACT}`;
  }
  const issues = `${nearGate} issue${nearGate === 1 ? '' : 's'}`;
  return `Nothing is waiting at the release gate, so there is no release to cut. ${issues} on this project stand one move short of it, at \`testing\` or at \`tested\`: a release carries an issue only once its status is \`awaiting_release\`. ${NEAR_GATE_ACT}`;
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
  if (code === 'RELEASE_ROSTER_EMPTY' && typeof details?.nearGate === 'number') {
    return nearGateSentence(details.nearGate);
  }
  if (code === 'RELEASE_CRITERIA_UNEARNED') {
    const held = (details?.held as HeldIssueRef[] | undefined) ?? [];
    const clears = (details?.clears as string[] | undefined) ?? [];
    const said = clears.length === 0 ? remedy : criteriaUnreadSentence(clears);
    return held.length === 0 ? said : heldIssuesSentence(said, held);
  }
  const carried = carriedSentence(code, details);
  if (carried) return carried;
  if (code === 'RELEASE_RUNTIME_UNROUTED' && typeof details?.missing === 'string') {
    return unroutedSentence(remedy, details.missing, details);
  }
  if (code === 'RELEASE_WORK_UNMERGED' && details?.shape === 'outside_git') {
    return `${namedHere(details)} have no mark saying where their work landed. Their work lands outside git, so mark each one merged with its \`landing\` — the live URL, CMS entry or storefront resource the work now is — first: a release records what shipped, and a mark naming nothing does not say that anything did.`;
  }
  if (code === 'RELEASE_ISSUES_UNCLOSABLE' && Array.isArray(details?.refused)) {
    return unclosableSentence(details.refused as UnclosableIssueRef[]);
  }
  if (code === 'RELEASE_TARGET_UNDECLARED' && Array.isArray(details?.releaseChain)) {
    const chain = details.releaseChain as { branch?: unknown }[];
    const last = chain[chain.length - 1]?.branch;
    return `This project's release chain ends at \`${String(last)}\` and it has no active deploy binding carrying the \`live\` stage, so there is nowhere for a release to land. Add one on the integrations screen, or, if this project ships nothing, press "This project ships nothing" on its Repository settings tab.`;
  }
  if (code === 'RELEASE_RUNNER_AMBIGUOUS' && Array.isArray(details?.labels)) {
    const labels = details.labels as string[];
    return `Two live deploy bindings name different release runners (${labels.join(', ')}), so there is no one box the release job may be offered to. Make the labels agree, or clear all but one.`;
  }
  const standings = code === 'CLAIM_CONFLICT' ? readClaimConflictDetails(details) : null;
  if (standings) {
    return claimConflictSentence(standings.projectId, standings.gateStatus, standings.conflicts);
  }
  if (Array.isArray(details?.issueIds))
    return remedy.replace('{n} issue(s) named here', namedHere(details));
  if (code === 'RELEASE_PROBES_UNREADABLE') return unreadableSentence(remedy, details);
  const urls = details?.urls;
  if (Array.isArray(urls) && urls.length > 0) return `${urls.join(', ')} — ${remedy}`;
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

/** The three carried codes, composed from the range and the issues the check named (ISS-1386). */
function carriedSentence(
  code: ReleaseBlockerCode,
  details: Record<string, unknown> | undefined,
): string | null {
  const short = (sha: unknown) => `\`${String(sha).slice(0, 12)}\``;
  if (code === 'RELEASE_CARRIES_UNDECIDED' && Array.isArray(details?.carried)) {
    const carried = details.carried as Array<{ displayId: string; status: string }>;
    const each = carried.map((i) => `\`${i.displayId}\` at \`${i.status}\``).join(', ');
    return `This release promotes \`${String(details.start)}\` at ${short(details.cut)} onto \`${String(details.live)}\`, and that range carries the landing of ${carried.length} issue(s) this batch does not name: ${each}. ${CARRIED_WAYS_OUT}`;
  }
  if (code === 'RELEASE_CARRIED_DECISION_REFUSED' && Array.isArray(details?.refused)) {
    const refused = details.refused as Array<{ displayId: string; decision: string; why: string }>;
    const each = refused.map((r) => `\`${r.displayId}\` \`${r.decision}\`: ${r.why}`).join('; ');
    return `${refused.length} decision(s) sent with this batch do not hold — ${each}. Correct each one and send the batch again.`;
  }
  if (code === 'RELEASE_CUT_DROPS_ROSTER' && Array.isArray(details?.displayIds)) {
    const named = (details.displayIds as string[]).map((id) => `\`${id}\``).join(', ');
    return `A \`cut-below\` moves this release to ${short(details.cut)}, which leaves the landing of roster issue(s) ${named} above the cut, so the batch would name issues it does not ship. Take them off the roster, or decide the carried issue another way.`;
  }
  return null;
}

/** The warning a promote chain with no route to read its repository gets instead; `why` says which
 *  route to declare, in the words of the host its URL names. */
export function carriedUnreadWarningSentence(why: string): string {
  return withCosts(
    'RELEASE_CARRIED_UNREAD',
    `This project promotes a branch onto production and Forge has no route to read its repository, so it could not read which landings this release carries beyond the issues it names: ${why}. Once it can, every release names each issue its range carries.`,
  );
}

/** How many issues a refusal is about, and which, by the id a screen shows (ISS-1346). */
/** One issue the finish's close would refuse, as `RELEASE_ISSUES_UNCLOSABLE` carries it. */
export interface UnclosableIssueRef {
  issueId: string;
  displayId: string;
  shortfalls: Array<{ code: string; reason: string; clears: string }>;
}

function unclosableSentence(refused: readonly UnclosableIssueRef[]): string {
  const each = refused
    .map(
      (r) =>
        `\`${r.displayId}\` ${r.shortfalls.map((s) => `${s.reason} (${s.code}): ${s.clears}`).join(' ')}`,
    )
    .join(' ');
  const n = refused.length;
  return `${n} issue${n === 1 ? '' : 's'} named here would be refused ${n === 1 ? 'its' : 'their'} close when this release finishes, so it would release ${n === 1 ? 'it' : 'them'} and hand ${n === 1 ? 'it' : 'them'} back to the gate. ${each} Clear each reason, or leave the issue off this release.`;
}

function namedHere(details: Record<string, unknown>): string {
  const ids = Array.isArray(details.issueIds) ? details.issueIds : [];
  const shown = Array.isArray(details.displayIds) ? (details.displayIds as string[]) : [];
  const which = shown.length === 0 ? '' : ` (${shown.map((id) => `\`${id}\``).join(', ')})`;
  return `${ids.length} issue(s) named here${which}`;
}

/** The route is read off the bindings the project has, so a provider that cannot report a commit is
 *  never told to become one (ISS-1346, judge finding 4). */
function unroutedSentence(
  remedy: string,
  missing: string,
  details: Record<string, unknown>,
): string {
  const route =
    typeof details.route === 'string' ? ` The way to give it one: ${details.route}.` : '';
  const held = (details.held as HeldIssueRef[] | undefined) ?? [];
  const lead = `${remedy} What is missing: ${missing}.${route}`;
  return held.length === 0 ? lead : heldIssuesSentence(lead, held);
}

/** A `verify` Forge refused takes no project default, so removing it is a repair and not silence. */
const REFUSED_DECLARATION_SENTENCE =
  'declares a `verify` Forge cannot read — it names no probe with a url — and a declared `verify` takes NO project default, so no release can be proved there and none closes past it. Correct it to `{"probes":[{"url":"https://<host>/api/health","commitPath":"commit"}]}`, or remove it: the project\'s `environments.live.commitUrl` then answers, and with neither the release is recorded unverified.';

function unreadableSentence(remedy: string, details?: Record<string, unknown>): string {
  const urls = Array.isArray(details?.urls) ? (details.urls as string[]) : [];
  const bindings = Array.isArray(details?.bindings) ? (details.bindings as string[]) : [];
  const parts: string[] = [];
  if (urls.length > 0) parts.push(`${urls.join(', ')} — ${remedy}`);
  if (bindings.length > 0) {
    const which = bindings.map((b) => `\`${b}\``).join(', ');
    parts.push(
      `The live deploy binding${bindings.length === 1 ? '' : 's'} ${which} ${REFUSED_DECLARATION_SENTENCE}`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : remedy;
}

/** The sweep is cutting a release and leaving these behind, which stops nothing. */
export function uncorroboratedWarningSentence(held: HeldIssueRef[], why: string): string {
  const issues = `${held.length} issue${held.length === 1 ? '' : 's'}`;
  const each = held
    .map((h) => `\`${h.displayId}\` on criterion ${h.criteria.join(', ')}`)
    .join('; ');
  return withCosts(
    'RELEASE_CRITERIA_UNCORROBORATED',
    `${issues} carry a criterion earned at a runtime nothing here could re-read: ${why} Those verdicts count — absence of a reading is not a failure — and they are weaker evidence than a reading would have made them. Whether each issue ships is decided by its own criteria, not by this. ${each}.`,
  );
}

/** Where nothing can read what the project serves, no judging run earns a criterion, so the remedy
 *  is the project's route and not a verdict (ISS-1346, judge r2 finding 1). */
export function heldBackWarningSentence(
  held: HeldIssueRef[],
  serving: ServingReading,
  clears: readonly string[] = [],
): string {
  const issues = `${held.length} issue${held.length === 1 ? '' : 's'}`;
  const lead = `A release will still be cut, without ${issues} the sweep is holding back`;
  const why =
    serving.kind === 'undeclared'
      ? `${lead}: each owes an acceptance criterion, and nothing here can read what this project is serving, so no judging run can earn one until the project can be read. What is missing: ${serving.missing}. The way to give it one: ${serving.route}.`
      : clears.length > 0
        ? `${lead}: each still owes an acceptance criterion, and at least one could not be weighed because the repository could not be read. ${readableFirst(clears, 'that')} Otherwise each stays at the gate until a judging run earns it.`
        : `${lead}: each still owes a judging run on an acceptance criterion, and stays at the gate until it is earned.`;
  return withCosts('RELEASE_CRITERIA_HELD_BACK', heldIssuesSentence(why, held));
}

/** The declared release label no box carries. Here, not at the call site: this module owns every
 *  sentence a door prints (ISS-1127). Each act names the screen it is taken on, the free one
 *  having been offered for a round with none. The label matches `runners.labels`, the box a
 *  release RUNS on, not the one holding the deploy credential — on Coolify, Forge (ISS-1275). */
export function runnerPreferenceUnmetSentence(label: string): string {
  return withCosts(
    'RELEASE_RUNNER_PREFERENCE_UNMET',
    `No box on this project carries the declared release label \`${label}\`, so this release goes to the pool this project has. Two ways out, either one complete. Label the box you want this project's releases to run on with \`${label}\` under ${RUNNERS_TAB}. Or clear \`releaseRunnerLabel\` from the live deploy binding under ${INTEGRATIONS_TAB} AND from the connection behind it under ${CONNECTIONS_DIRECTORY}, which asks for no box and stops nothing: a project declaring no release runner releases on the pool it has, and this warning goes with the label. Clearing it from the binding alone falls back to the connection's label rather than to none.`,
  );
}
