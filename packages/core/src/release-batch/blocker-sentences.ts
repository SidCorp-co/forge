/**
 * The code an operator learns a release refusal by, and the sentence that
 * explains it. Every door reads these, so none carries its own copy (ISS-1127).
 */

import { RELEASE_RECORD_REMEDY } from '../issues/release-record-required.js';
import { AGENT_NAMING_MIN_RUNNER } from '../runners/device-cap.js';
import type { RunnerHold, RunnerHoldReason } from '../runners/ineligible.js';
import type { ReleaseDeclaration } from './gate.js';
import type { ReleaseChannel } from './plan.js';

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
  | 'RELEASE_RUNNER_AMBIGUOUS'
  | 'RELEASE_RUNNER_UNDECLARED'
  | 'RELEASE_PROBES_UNDECLARED'
  | 'RELEASE_PROBES_UNREADABLE'
  | 'RELEASE_POOL_EMPTY'
  | 'NO_RUNNER_ONLINE'
  | 'RELEASE_BRANCHES_UNDECLARED'
  | 'RELEASE_MULTI_CHANNEL_UNSUPPORTED'
  | 'BATCH_IN_FLIGHT'
  | 'RELEASE_CRITERIA_UNEARNED'
  | 'RELEASE_CHECK_UNEVALUATED';

export type ReleaseWarningCode = 'RELEASE_RUNNER_PREFERENCE_UNMET' | 'RELEASE_CRITERIA_HELD_BACK';

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
}

export type ReleaseDoor = 'batch' | 'record';

export interface CollectReleaseBlockersOptions {
  /** The issues this call names. Omitted, the project's whole roster is read. */
  issueIds?: string[] | undefined;
  door?: ReleaseDoor | undefined;
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

const REMEDY: Record<ReleaseBlockerCode, string> = {
  NO_RELEASE_GATE:
    'This project has no release gate configured, so there is no release to start — an agent `closed` here is already `closed`. Declare a release model, or leave it at `none`.',
  RELEASE_TARGET_UNDECLARED:
    'This project declares a release model and has no active deploy binding carrying the `live` stage, so there is nowhere for a release to land. Add one on the integrations screen, or set the release model to `none`.',
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
  RELEASE_RUNNER_AMBIGUOUS:
    'Two live deploy bindings name different release runners, so there is no one box the release job may be offered to. Make the labels agree, or clear all but one.',
  RELEASE_RUNNER_UNDECLARED:
    'This project declares a release model and no live deploy binding names a release runner, so there is no box the release job may be offered to and none will take it. Set `releaseRunnerLabel` on the live deploy binding. It names the box a release should PREFER and does not restrict the pool: where no box on the project carries that label the release goes to the pool this project has, so a project with one box may name anything.',
  RELEASE_PROBES_UNDECLARED:
    'One of this project\'s live deploy bindings declares no verification probes, so nothing but the agent\'s own word could say the release happened. Two ways out. Either record where this project is deployed — `environments.live.commitUrl`, the endpoint that reports the running commit, and `environments.live.commitPath`, the dot path to it inside that endpoint\'s JSON body (`commit`, or `data.commit`; leave it empty where the whole body is the commit) — which answers this for every live binding at once. Or declare probes on the binding itself, which overrides the project\'s: `verify` = `{"probes":[{"url":"https://<host>/api/health","commitPath":"commit"}]}`. A binding that declares a `verify` Forge cannot read takes NO project default: correct it or remove it.',
  RELEASE_PROBES_UNREADABLE:
    'A declared verification probe holds a url that is not a url, so no request could ever be made to it and the release would fail while reading what production is serving. Correct the probe, including its scheme.',
  RELEASE_POOL_EMPTY:
    'This project has no runner registered, so there is no box a release could run on. Pair a box to this project first.',
  NO_RUNNER_ONLINE:
    'This project has runners registered and none of them could be handed a release, and the reading of why could not be taken. Open Settings \u2192 Runners and check each box\'s "Takes jobs from the pool" switch and when it was last seen.',
  RELEASE_BRANCHES_UNDECLARED:
    'This project declares no base branch, so there is nothing a release could promote from. Set it in the project settings.',
  RELEASE_MULTI_CHANNEL_UNSUPPORTED:
    'This project declares more than one live deploy binding, and a release run records ONE reading used to close the whole roster. Leave exactly one binding carrying the `live` stage active, or release them as separate projects.',
  BATCH_IN_FLIGHT:
    'A release is already running for this project, and a second one would claim the same issues. Let it finish, or abort it with what you found.',
  RELEASE_CRITERIA_UNEARNED:
    'This project releases without a person acting, and the sweep that cuts its releases is holding back every issue waiting at the gate: each still owes a judging run on an acceptance criterion. Record a verdict for each criterion named below, or move the issue out of `awaiting_release` if it is not to ship.',
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

const WITHDRAW_RUNNER_LABEL: RemedyAct = {
  // Both places: a binding-only withdrawal leaves the connection's standing.
  act: 'Withdrawing the label instead, by sending `releaseRunnerLabel` as `null` on every live deploy binding and on the connection behind it,',
  worded: ['withdraw', 'withdrawing'],
  raises: 'RELEASE_RUNNER_UNDECLARED',
};

/** Over both unions, so a code added later cannot skip the question. */
export const REMEDY_COST: Record<ReleaseReasonCode, readonly RemedyAct[]> = {
  NO_RELEASE_GATE: [],
  RELEASE_TARGET_UNDECLARED: [],
  CLAIM_CONFLICT: [],
  RELEASE_ROSTER_EMPTY: [],
  RELEASE_ROSTER_OVERSIZE: [],
  RELEASE_RECORD_MISSING: [],
  RELEASE_WORK_UNMERGED: [],
  RELEASE_RUNNER_AMBIGUOUS: [],
  RELEASE_RUNNER_UNDECLARED: [],
  RELEASE_PROBES_UNDECLARED: [],
  RELEASE_PROBES_UNREADABLE: [],
  RELEASE_POOL_EMPTY: [],
  NO_RUNNER_ONLINE: [],
  RELEASE_BRANCHES_UNDECLARED: [],
  RELEASE_MULTI_CHANNEL_UNSUPPORTED: [],
  BATCH_IN_FLIGHT: [],
  RELEASE_CRITERIA_UNEARNED: [],
  RELEASE_CHECK_UNEVALUATED: [],
  RELEASE_RUNNER_PREFERENCE_UNMET: [WITHDRAW_RUNNER_LABEL],
  RELEASE_CRITERIA_HELD_BACK: [],
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

/**
 * What clears this reading, per reading.
 *
 * Every one of them answers, because a reading with no act is the sentence this
 * file was rewritten to stop printing: correct about the state and silent about
 * what to do with it. Where nobody can act — a rate limit, a quarantine, a
 * provision in flight — the clause says what is being waited out and until when,
 * which is an answer too (ISS-1127).
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
 * Three codes read their details rather than printing a literal, because their
 * literal could only describe one of the states that reach them. The rest are
 * unchanged.
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
    return held.length === 0 ? remedy : heldIssuesSentence(remedy, held);
  }
  if (code === 'RELEASE_TARGET_UNDECLARED' && typeof details?.releaseModel === 'string') {
    return `This project declares releaseModel \`${details.releaseModel}\` and has no active deploy binding carrying the \`live\` stage, so there is nowhere for a release to land. Add one on the integrations screen, or set the release model to \`none\`.`;
  }
  if (code === 'RELEASE_RUNNER_AMBIGUOUS' && Array.isArray(details?.labels)) {
    const labels = details.labels as string[];
    return `Two live deploy bindings name different release runners (${labels.join(', ')}), so there is no one box the release job may be offered to. Make the labels agree, or clear all but one.`;
  }
  if (code === 'RELEASE_MULTI_CHANNEL_UNSUPPORTED' && typeof details?.count === 'number') {
    return `This project declares ${details.count} live deploy bindings, and a release run records ONE reading used to close the whole roster. Leave exactly one binding carrying the \`live\` stage active, or release them as separate projects.`;
  }
  const issueIds = details?.issueIds;
  if (Array.isArray(issueIds)) return remedy.replace('{n}', String(issueIds.length));
  const urls = details?.urls;
  if (Array.isArray(urls) && urls.length > 0) return `${urls.join(', ')} — ${remedy}`;
  const check = details?.check;
  if (typeof check === 'string') return `The \`${check}\` check could not be run. ${remedy}`;
  const waiting = details?.waiting;
  if (typeof waiting === 'number') return `${waiting} waiting. ${remedy}`;
  return remedy;
}

/** The sweep is cutting a release and leaving these behind, which stops nothing. */
export function heldBackWarningSentence(held: HeldIssueRef[]): string {
  const issues = `${held.length} issue${held.length === 1 ? '' : 's'}`;
  return withCosts(
    'RELEASE_CRITERIA_HELD_BACK',
    heldIssuesSentence(
      `A release will still be cut, without ${issues} the sweep is holding back: each still owes a judging run on an acceptance criterion, and stays at the gate until it is earned.`,
      held,
    ),
  );
}

/** The declared release label no box carries. Here, not at the call site: this
 *  module owns every sentence a door prints, warnings included (ISS-1127). */
export function runnerPreferenceUnmetSentence(label: string): string {
  return withCosts(
    'RELEASE_RUNNER_PREFERENCE_UNMET',
    `No box on this project carries the declared release label \`${label}\`, so this release goes to the pool this project has. Label the box that holds the deploy credential with \`${label}\` under ${RUNNERS_TAB}.`,
  );
}
