/**
 * The code an operator learns a release refusal by, and the sentence that
 * explains it. Every door reads these, so none carries its own copy (ISS-1127).
 */

import type { ReleaseBlockerCode } from '@forge/contracts/releases';
import { type LiveShortfall, notLiveSentence } from '@forge/contracts/contract-waits';
import { RELEASE_RECORD_REMEDY } from '../issues/release-record-required.js';
import { agrees, counted } from '../lib/plural.js';
import { AGENT_NAMING_MIN_RUNNER } from '../runners/device-cap.js';
import type { RunnerHold, RunnerHoldReason } from '../runners/ineligible.js';
import { claimConflictSentence, readClaimConflictDetails } from './claim-conflicts.js';
import type { ReleaseDeclaration } from './gate.js';
import type { ReleaseChannel } from './plan.js';
import type { ServingReading } from './serving-reading.js';

/** The most issues one release may carry; `resolveRoster` holds every door to it. */
export const RELEASE_ROSTER_LIMIT = 50;

export type { ReleaseBlockerCode };

export type ReleaseWarningCode =
  | 'RELEASE_RUNNER_PREFERENCE_UNMET'
  | 'RELEASE_CRITERIA_HELD_BACK'
  | 'RELEASE_CRITERIA_UNCORROBORATED';

/** Every reason this project answers with, whether or not it stops a release. */
export type ReleaseReasonCode = ReleaseBlockerCode | ReleaseWarningCode;

export interface ReleaseBlocker {
  code: ReleaseBlockerCode;
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
  /** Read by the CALLER — this enumerator reaches no network; without one the criteria check
   *  reports itself unevaluated rather than guess (ISS-1286). */
  serving?: ServingReading | undefined;
}

const REMEDY: Record<ReleaseBlockerCode, string> = {
  NO_RELEASE_GATE:
    'This project has no release step, so Forge has no release to start or record: here, closing an issue is what ships it. Close these issues to ship them. To release through Forge instead, declare a production environment with a deploy binding in the project document, written with PUT /api/projects/:id/config.',
  RELEASE_TARGET_UNDECLARED:
    'Nothing says where a release of this project lands: the project document is missing, or its production environment has no active deploy binding, or no promotion reaches the branch it deploys from. Correct the project document (`PUT /api/projects/:id/config`), or declare no production environment if Forge ships nothing here.',
  CLAIM_CONFLICT:
    '{named} {are} not at the release gate, {are} not on this project, or {are} already claimed by a batch. Read the roster and send the issues it lists.',
  RELEASE_ROSTER_EMPTY:
    'Nothing is waiting at the release gate, so there is no release to cut. An issue reaches it by moving to `awaiting_release`, which is an act of its own.',
  RELEASE_ROSTER_OVERSIZE: `More issues are waiting than one release may carry. A release names at most ${RELEASE_ROSTER_LIMIT} issues, so cut this roster in parts, oldest merge first.`,
  RELEASE_RECORD_MISSING:
    '{named} {have} no release note, and closing {them} would claim a ship ' +
    `nobody wrote anything about. ${RELEASE_RECORD_REMEDY}`,
  RELEASE_WORK_UNMERGED:
    '{named} {have} no merge Forge watched land, so nothing says {their} work is on the branch this release deployed. Mark the merge on {each} first — a release records what shipped, and an issue nobody merged did not.',
  CONTRACT_PROVIDER_NOT_LIVE:
    "{named} {wait} on another project's contract version that its production does not serve yet, so this release would ship a consumer ahead of its provider. Release once the provider serves it, or take {those} out of this release.",
  RELEASE_PROBES_UNREADABLE:
    'Every runtime probe the production environment declares identifies an artifact, so no reading can say which commit production serves and the release could never be proved. Declare a probe that identifies the source on the production environment.',
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
  CONTRACT_PROVIDER_NOT_LIVE: [],
  RELEASE_PROBES_UNREADABLE: [],
  RELEASE_POOL_EMPTY: [],
  NO_RUNNER_ONLINE: [],
  BATCH_IN_FLIGHT: [],
  RELEASE_CRITERIA_UNEARNED: [],
  RELEASE_RUNTIME_UNROUTED: [],
  RELEASE_CHECK_UNEVALUATED: [],
  RELEASE_RUNNER_PREFERENCE_UNMET: [],
  RELEASE_CRITERIA_HELD_BACK: [],
  RELEASE_CRITERIA_UNCORROBORATED: [],
};

export function remedyCostClause(cost: RemedyAct): string {
  return `${cost.act} raises \`${cost.raises}\`, which does stop a release until it is answered.`;
}

function withCosts(code: ReleaseReasonCode, sentence: string): string {
  const costs = REMEDY_COST[code];
  return costs.length === 0 ? sentence : [sentence, ...costs.map(remedyCostClause)].join(' ');
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
  const count = counted(holds.length, 'runner');
  const head = `This project has ${count} registered and not one of them can take a release right now.`;
  return `${head} ${holds.map(runnerHoldClause).join(' ')}`;
}

function heldIssuesSentence(remedy: string, held: HeldIssueRef[]): string {
  const each = held
    .map(
      (h) =>
        `\`${h.displayId}\` owes ${agrees(h.criteria.length, 'criterion', 'criteria')} ${h.criteria.join(', ')}`,
    )
    .join('; ');
  return `${remedy} ${each}.`;
}

const NEAR_GATE_ACT =
  'An issue moves there once its own record earns it: the verification naming where the ' +
  'change now runs, at which commit and on what evidence, plus the release note where one ' +
  "is owed. With those written, the issue's own status control makes the move.";

function nearGateSentence(nearGate: number): string {
  if (nearGate === 0) {
    return `Nothing is waiting at the release gate, and nothing stands one move short of it: no issue on this project is \`in_progress\` at its test step. An issue reaches the gate at \`awaiting_release\`, once every criterion holds a passing verdict. ${NEAR_GATE_ACT}`;
  }
  const issues = counted(nearGate, 'issue');
  return `Nothing is waiting at the release gate, so there is no release to cut. ${issues} on this project ${agrees(nearGate, 'stands', 'stand')} one move short of it, \`in_progress\` at ${agrees(nearGate, 'its', 'their')} test step: a release carries an issue only once its status is \`awaiting_release\`. ${NEAR_GATE_ACT}`;
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
  const remedy = fillNamed(REMEDY[code], details);
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
  if (code === 'RELEASE_RUNTIME_UNROUTED' && typeof details?.missing === 'string') {
    return unroutedSentence(remedy, details.missing, details);
  }
  if (code === 'RELEASE_WORK_UNMERGED' && details?.shape === 'outside_git') {
    return fillNamed('{named} {have} no mark saying where {their} work landed.', details).concat(
      ` This project's work lands outside git, so mark each one merged with its \`landing\` — the live URL, CMS entry or storefront resource the work now is — first: a release records what shipped, and a mark naming nothing does not say that anything did.`,
    );
  }
  if (code === 'CONTRACT_PROVIDER_NOT_LIVE' && Array.isArray(details?.waits)) {
    return notLiveSentence(details.waits as LiveShortfall[]);
  }
  if (code === 'RELEASE_TARGET_UNDECLARED' && typeof details?.reason === 'string') {
    return `Nowhere is declared for a release to land: ${details.reason}.`;
  }
  const standings = code === 'CLAIM_CONFLICT' ? readClaimConflictDetails(details) : null;
  if (standings) {
    return claimConflictSentence(standings.projectId, standings.gateStatus, standings.conflicts);
  }
  if (Array.isArray(details?.issueIds)) return remedy;
  if (code === 'RELEASE_PROBES_UNREADABLE') return unreadableSentence(remedy, details);
  const urls = details?.urls;
  if (Array.isArray(urls) && urls.length > 0) return `${urls.join(', ')} — ${remedy}`;
  const check = details?.check;
  if (typeof check === 'string') return `The \`${check}\` check could not be run. ${remedy}`;
  const waiting = details?.waiting;
  if (typeof waiting === 'number') return `${waiting} waiting. ${remedy}`;
  return remedy;
}

const AGREEMENT: readonly (readonly [string, string, string])[] = [
  ['{are}', 'is', 'are'],
  ['{have}', 'has', 'have'],
  ['{wait}', 'waits', 'wait'],
  ['{them}', 'it', 'them'],
  ['{their}', 'its', 'their'],
  ['{each}', 'it', 'each of them'],
  ['{those}', 'that issue', 'those issues'],
];

/** How many issues a refusal is about, and which, by the id a screen shows (ISS-1346). */
function fillNamed(template: string, details?: Record<string, unknown>): string {
  if (!template.includes('{named}')) return template;
  const ids = Array.isArray(details?.issueIds) ? details.issueIds : null;
  const shown = Array.isArray(details?.displayIds) ? (details.displayIds as string[]) : [];
  const which = shown.length === 0 ? '' : ` (${shown.map((id) => `\`${id}\``).join(', ')})`;
  const n = ids ? ids.length : 0;
  const subject = ids
    ? `${counted(ids.length, 'issue')} named here${which}`
    : 'The issues named here';
  return AGREEMENT.reduce(
    (text, [token, one, many]) => text.replaceAll(token, agrees(n, one, many)),
    template.replace('{named}', subject),
  );
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

/** A probe identifying the artifact cannot prove a commit, so removing it is a repair and not silence. */
const REFUSED_DECLARATION_SENTENCE =
  'declares runtime probes that all identify the artifact, and a release proves the commit it shipped, so no release can be proved there and none closes past it. Add a probe with `"identifies": "source"` to its `verification.runtime`, or remove the probes and the release is recorded unverified.';

function unreadableSentence(remedy: string, details?: Record<string, unknown>): string {
  const bindings = Array.isArray(details?.bindings) ? (details.bindings as string[]) : [];
  return bindings.length > 0
    ? `Production ${bindings.join(', ')} ${REFUSED_DECLARATION_SENTENCE}`
    : remedy;
}

export function uncorroboratedWarningSentence(held: HeldIssueRef[], why: string): string {
  const issues = counted(held.length, 'issue');
  const each = held
    .map(
      (h) =>
        `\`${h.displayId}\` on ${agrees(h.criteria.length, 'criterion', 'criteria')} ${h.criteria.join(', ')}`,
    )
    .join('; ');
  return withCosts(
    'RELEASE_CRITERIA_UNCORROBORATED',
    `${issues} ${agrees(held.length, 'carries', 'carry')} a criterion earned at a runtime nothing here could re-read: ${why} Those verdicts count — absence of a reading is not a failure — and they are weaker evidence than a reading would have made them. Whether each issue ships is decided by its own criteria, not by this. ${each}.`,
  );
}

/** Where nothing can read what the project serves, no judging run earns a criterion, so the remedy
 *  is the project's route and not a verdict (ISS-1346, judge r2 finding 1). */
export function heldBackWarningSentence(held: HeldIssueRef[], serving: ServingReading): string {
  const issues = counted(held.length, 'issue');
  const lead = `A release will still be cut, without ${issues} the sweep is holding back`;
  const why =
    serving.kind === 'undeclared'
      ? `${lead}: each owes an acceptance criterion, and nothing here can read what this project is serving, so no judging run can earn one until the project can be read. What is missing: ${serving.missing}. The way to give it one: ${serving.route}.`
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
    `No box on this project carries the declared release label \`${label}\`, so this release goes to the pool this project has. Two ways out, either one complete. Label the box you want this project's releases to run on with \`${label}\` under ${RUNNERS_TAB}. Or clear \`releaseRunnerLabel\` from the production deploy binding under ${INTEGRATIONS_TAB} AND from the connection behind it under ${CONNECTIONS_DIRECTORY}, which asks for no box and stops nothing: a project declaring no release runner releases on the pool it has, and this warning goes with the label. Clearing it from the binding alone falls back to the connection's label rather than to none.`,
  );
}
