/**
 * The code an operator learns a release refusal by, and the one sentence that
 * explains it.
 *
 * Split from `blockers.ts` when that file crossed the 500-line budget, on the
 * seam the module already had: this is the text somebody reads, and what is
 * left there is the reading that decides which of these applies. It is also
 * what lets `refusals.ts` and `blockers.ts` share one copy of each sentence
 * without closing a cycle through `service.ts` (ISS-1127).
 *
 * `refusals.ts` states the rule these serve: a caller that learns
 * `RELEASE_PROBES_UNDECLARED` at one door must not meet a second name, or a
 * second wording, for the same fact at another.
 */

import { RELEASE_RECORD_REMEDY } from '../issues/release-record-required.js';
import type { ReleaseDeclaration } from './gate.js';
import type { ReleaseChannel } from './plan.js';

/** The most issues one call may name, which `createBodySchema` also holds. */
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
  | 'RELEASE_CHECK_UNEVALUATED';

export interface ReleaseBlocker {
  code: ReleaseBlockerCode;
  /** 409 where a declaration or a roster must change, 503 where the fleet must. */
  httpStatus: 409 | 503;
  /** The one sentence an operator reads, identical at every door. */
  message: string;
  details?: Record<string, unknown>;
  /** False only on `RELEASE_CHECK_UNEVALUATED`: this check could not be run. */
  evaluated: boolean;
  /** Set where the answer is about the project's own roster, not a named list. */
  scope?: 'roster';
}

/** Something that changes how a release runs without being a reason it will not. */
export interface ReleaseWarning {
  code: 'RELEASE_RUNNER_PREFERENCE_UNMET';
  message: string;
  details?: Record<string, unknown>;
}

export interface ReleaseBlockerReport {
  projectId: string;
  projectExists: boolean;
  /** Null where the project is absent, or where the read failed. */
  declaration: ReleaseDeclaration | null;
  /** Null where the read failed — distinct from a project declaring none. */
  channels: ReleaseChannel[] | null;
  blockers: ReleaseBlocker[];
  warnings: ReleaseWarning[];
}

/**
 * Which door is asking. `batch` cuts a release and needs a box to cut it on;
 * `record` writes down one that already happened and deliberately needs no
 * runner, label or job (ISS-1129), and asks instead that the work was merged.
 */
export type ReleaseDoor = 'batch' | 'record';

export interface CollectReleaseBlockersOptions {
  /** The issues this call names. Omitted, the project's whole roster is read. */
  issueIds?: string[] | undefined;
  door?: ReleaseDoor | undefined;
}

/**
 * An error carrying every reason that stood when it was thrown, not only its own.
 *
 * The first blocker keeps its existing class, its code and its wording, so no
 * caller's `instanceof` and no operator's vocabulary moves. What is added is the
 * rest of the list, which is the whole of ISS-1127: two refusals minutes apart,
 * each individually correct and neither mentioning the other.
 */
export type ReleaseBlockedError = Error & { releaseBlockers?: ReleaseBlocker[] };

export function blockersOf(err: unknown): ReleaseBlocker[] {
  const carried = (err as ReleaseBlockedError | null)?.releaseBlockers;
  return Array.isArray(carried) ? carried : [];
}

/** The reasons standing beside the one being thrown, for a refusal body. */
export function alsoBlocking(err: unknown, thrown: ReleaseBlockerCode): ReleaseBlocker[] {
  return blockersOf(err).filter((b) => b.code !== thrown);
}

const REMEDY: Record<ReleaseBlockerCode, string> = {
  NO_RELEASE_GATE:
    'This project has no release gate configured, so there is no release to start — an agent `closed` here is already `closed`. Declare a release model, or leave it at `none`.',
  RELEASE_TARGET_UNDECLARED:
    'This project declares a release model and has no active deploy binding carrying the `live` stage, so there is nowhere for a release to land. Add one on the integrations screen, or set the release model to `none`.',
  CLAIM_CONFLICT:
    '{n} issue(s) named here are not at the release gate, are not on this project, or are already claimed by a batch. Read the roster and send the issues it lists.',
  RELEASE_ROSTER_EMPTY:
    'Nothing is waiting at the release gate, so there is no release to cut. An issue reaches it by being merged and marked, and until one does there is nothing to ship.',
  RELEASE_ROSTER_OVERSIZE: `More issues are waiting than one release may carry. A release names at most ${RELEASE_ROSTER_LIMIT} issues, so cut this roster in parts, oldest merge first.`,
  RELEASE_RECORD_MISSING:
    '{n} issue(s) named here have no release note, and closing them would claim a ship ' +
    `nobody wrote anything about. ${RELEASE_RECORD_REMEDY}`,
  RELEASE_WORK_UNMERGED:
    '{n} issue(s) named here have no merge Forge watched land, so nothing says their work is on the branch this release deployed. Mark the merge on each of them first — a release records what shipped, and an issue nobody merged did not.',
  RELEASE_RUNNER_AMBIGUOUS:
    'Two live deploy bindings name different release runners, so there is no one box the release job may be offered to. Make the labels agree, or clear all but one.',
  RELEASE_RUNNER_UNDECLARED:
    'This project declares a release model and no live deploy binding names a release runner. Set `releaseRunnerLabel` on one — it recommends a box, it does not stop the others releasing when that box is unavailable. Send `null` for that key to withdraw it again.',
  RELEASE_PROBES_UNDECLARED:
    "One of this project's live deploy bindings declares no verification probes, so nothing but the agent's own word could say the release happened. Record `environments.live.commitUrl` and `commitPath` for the project, or declare `verify` on the binding itself.",
  RELEASE_PROBES_UNREADABLE:
    'A declared verification probe holds a url that is not a url, so no request could ever be made to it and the release would fail while reading what production is serving. Correct the probe, including its scheme.',
  RELEASE_POOL_EMPTY:
    'This project has no runner registered, so there is no box a release could run on. Pair a box to this project first.',
  NO_RUNNER_ONLINE:
    'This project has runners registered and none of them is online and able to take a release right now. Bring one up, or wait for one to reconnect.',
  RELEASE_BRANCHES_UNDECLARED:
    'This project declares no base branch, so there is nothing a release could promote from. Set it in the project settings.',
  RELEASE_MULTI_CHANNEL_UNSUPPORTED:
    'This project declares more than one live deploy binding, and a release run records ONE reading used to close the whole roster. Leave exactly one binding carrying the `live` stage active, or release them as separate projects.',
  BATCH_IN_FLIGHT:
    'A release is already running for this project, and a second one would claim the same issues. Let it finish, or abort it with what you found.',
  RELEASE_CHECK_UNEVALUATED:
    'One of the checks that decides whether a release may start could not be run, so this answer cannot say a release would succeed. Everything else below was evaluated; this one was not.',
};

/**
 * The one copy of each sentence. Every door reads it, so a caller that learns a
 * code at one of them never meets a second wording for the same fact.
 */
export function releaseBlockerSentence(
  code: ReleaseBlockerCode,
  details?: Record<string, unknown>,
): string {
  const remedy = REMEDY[code];
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
