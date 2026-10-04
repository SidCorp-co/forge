import {
  describeProbeReading,
  PROBE_TIMEOUT_MS,
  probeAnswered,
  type RuntimeProbeTarget,
  readRuntimeProbe,
} from '../integrations/deploy/index.js';

interface VerifyProbe {
  url: string;
  /** Dot path into the JSON body. Omitted → the whole body, trimmed. */
  commitPath?: string | undefined;
}

export interface VerifyConfig {
  probes: VerifyProbe[];
  /** Give up after this long (300s), and believe a reading only `stableReads` (2) times running. */
  timeoutSeconds?: number;
  stableReads?: number;
}

/** Whether the application is alive, and the identity it reports if it is. */
export interface LiveState {
  health: 'up' | 'down';
  /** `null` when the fleet does not agree on one commit, or none reports one. */
  identity: string | null;
  /** Each probe that answered a commit, and the commit it answered, in declaration order. */
  answeredBy: Array<{ url: string; commit: string }>;
  /** One line per probe, in declaration order, whatever the outcome. */
  readings: string[];
  /** The probes whose reading is not a commit, by what went wrong. */
  unhealthy: string[];
  unidentified: string[];
  /** Set when every probe answered a commit and they disagree. */
  disagreement: string[] | null;
}

/**
 * One read of every probe, kept as two answers: health is every probe answering, identity is
 * every probe agreeing on one commit — a fleet half on the new build is healthy with no identity.
 */
export async function readLiveState(
  cfg: VerifyConfig,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<LiveState> {
  const targets = cfg.probes.map((p) => ({ url: p.url, path: p.commitPath }));
  const reads = await Promise.all(targets.map((t) => readRuntimeProbe(t, { timeoutMs })));
  const readings = reads.map((r, i) => describeProbeReading(targets[i] as RuntimeProbeTarget, r));
  const unhealthy = reads
    .map((r, i) => (probeAnswered(r) ? null : (readings[i] ?? null)))
    .filter((s): s is string => s !== null);
  const unidentified = reads
    .map((r, i) => (probeAnswered(r) && r.kind !== 'value' ? (readings[i] ?? null) : null))
    .filter((s): s is string => s !== null);

  const answeredBy = reads.flatMap((r, i) =>
    r.kind === 'value' ? [{ url: (cfg.probes[i] as VerifyProbe).url, commit: r.value }] : [],
  );
  const agreed =
    answeredBy.length === reads.length && answeredBy.length > 0
      ? answeredBy.every((r) => r.commit === answeredBy[0]?.commit)
        ? (answeredBy[0]?.commit ?? null)
        : null
      : null;
  const disagreement =
    answeredBy.length === reads.length && answeredBy.length > 0 && agreed === null
      ? [...new Set(answeredBy.map((r) => r.commit))]
      : null;

  return {
    health: unhealthy.length === 0 ? 'up' : 'down',
    identity: agreed,
    answeredBy,
    readings,
    unhealthy,
    unidentified,
    disagreement,
  };
}

/**
 * pass-through: keep — `createReleaseBatch` wants this one answer and nothing
 * else, the commit serving before anything moved, and reads it once. It throws on
 * an unparseable probe url (`readRuntimeProbe`), as `verifyDeployed` and
 * `verifyServingNow` do. Two doors screen ahead of them — `createReleaseBatch` and
 * `recordPerformedRelease`, through `collectReleaseBlockers` — so that throw is a
 * refusal, not a 500. `finishReleaseBatch` screens nothing (ISS-1127, ISS-1129 F3, F4).
 */
export async function readLiveCommit(cfg: VerifyConfig): Promise<string | null> {
  return (await readLiveState(cfg)).identity;
}

type VerifyOutcome =
  | {
      ok: true;
      commit: string;
      health: 'up';
      identity: string;
      /** Differs from what the batch found serving when it opened (ISS-1199). */
      moved: boolean;
    }
  | {
      ok: false;
      reason: string;
      live: string | null;
      health: 'up' | 'down';
      identity: string | null;
      readings: string[];
    };

interface VerifyArgs {
  cfg: VerifyConfig;
  /** What was serving before the release started. */
  commitBefore: string | null;
  /** The whole sha the release says it pushed, or `null` to ask only that the deploy arrived. */
  expected: string | null;
  checkpoint?: (() => Promise<void>) | undefined;
  /** Injected so the poll loop is testable without real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Whether one reading satisfies the gate: a claim is the whole proof where one
 *  is made, and only a claimless gate asks that the build left `commitBefore` —
 *  asking both leaves a batch opened after its own release stuck (ISS-1199). */
function readingSatisfies(
  live: string | null,
  commitBefore: string | null,
  claim: string | null,
): boolean {
  if (live === null) return false;
  // With no claim and nothing recorded before, every reading would look like a move.
  if (claim === null) return commitBefore !== null && live !== commitBefore;
  return deploymentConfirms(claim, live);
}

export async function verifyDeployed(args: VerifyArgs): Promise<VerifyOutcome> {
  const { cfg, commitBefore, expected } = args;
  const now = args.now ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (cfg.timeoutSeconds ?? 300) * 1000;
  const needed = cfg.stableReads ?? 2;

  const claim = expected == null ? null : claimedCommit(expected);
  let stable = 0;
  let last: string | null = null;
  let state: LiveState = {
    health: 'down',
    identity: null,
    answeredBy: [],
    readings: [],
    unhealthy: [],
    unidentified: [],
    disagreement: null,
  };

  while (now() < deadline) {
    await args.checkpoint?.();
    state = await readLiveState(cfg, deadline - now());
    // The gates no reading could satisfy, closed here, not at the deadline.
    if (expected != null && claim === null) {
      return { ...failureFor(state, commitBefore, null, expected), readings: state.readings };
    }
    if (claim === null && commitBefore === null) {
      const { health, identity, readings } = state;
      return { ok: false, reason: NOTHING_TO_COMPARE, live: identity, health, identity, readings };
    }
    const live = state.identity;
    const acceptable = readingSatisfies(live, commitBefore, claim);
    stable = acceptable && live === last ? stable + 1 : acceptable ? 1 : 0;
    last = live;
    if (stable >= needed && live != null) {
      return {
        ok: true,
        commit: live,
        health: 'up',
        identity: live,
        moved: live !== commitBefore,
      };
    }
    if (now() >= deadline) break;
    await sleep(5000);
  }

  return { ...failureFor(state, commitBefore, claim), readings: state.readings };
}

/**
 * Why the window closed red: health, then identity, then the claim — which is
 * only judgeable once there is a reading to judge it against.
 */
function failureFor(
  state: LiveState,
  commitBefore: string | null,
  claim: string | null,
  unusableClaim: string | null = null,
): Omit<Extract<VerifyOutcome, { ok: false }>, 'readings'> {
  const base = { ok: false as const, live: state.identity, identity: state.identity };
  if (state.health === 'down') {
    return {
      ...base,
      health: 'down',
      reason: `the application is not answering: ${state.unhealthy.join('; ')}`,
    };
  }
  if (state.disagreement) {
    return {
      ...base,
      health: 'up',
      reason: `the application is healthy and the fleet disagrees about what it is serving (${state.disagreement.join(', ')}) — a rollout that has not finished, not a failed build`,
    };
  }
  if (state.identity == null) {
    return {
      ...base,
      health: 'up',
      reason: `the application is healthy and no probe reported a commit (${state.unidentified.join('; ')}) — read this as a probe declaration that does not match what the application serves, not as a failed deploy`,
    };
  }
  if (claim !== null && deploymentConfirms(claim, state.identity)) {
    return {
      ...base,
      health: 'up',
      reason: `the deployment reports ${state.identity}, which is the commit the release pushed, and the window closed before that reading held still long enough to be believed`,
    };
  }
  if (state.identity === commitBefore) {
    const pushed = claim === null ? '' : `, and the release pushed ${claim}`;
    return {
      ...base,
      health: 'up',
      reason: `the live build is unchanged (${state.identity}) — the site is healthy and still serving the pre-release commit${pushed}`,
    };
  }
  if (unusableClaim !== null) {
    return { ...base, health: 'up', reason: notAWholeCommit(unusableClaim, state.identity) };
  }
  if (claim != null && !deploymentConfirms(claim, state.identity)) {
    return {
      ...base,
      health: 'up',
      reason: `live is ${state.identity}, the release pushed ${claim}`,
    };
  }
  return { ...base, health: 'up', reason: 'the live commit never held still' };
}

/** A whole git object name. The only shape a claim under test may take. */
const WHOLE_COMMIT = /^[0-9a-f]{40}$/;

/** What a deployment may report: a whole object name, or git's own abbreviation of one. */
const REPORTED_COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * The commit a caller claims, or `null` where it is not a whole object name. An
 * abbreviation is refused rather than compared: it is confirmed by every commit
 * it prefixes, so the caller would be choosing how much has to match (ISS-1161).
 */
export function claimedCommit(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  return WHOLE_COMMIT.test(text) ? text : null;
}

/**
 * The commit a deployment reports, whole or abbreviated, or `null` where it is
 * neither. Seven is git's own floor on an abbreviation and the floor here.
 */
export function reportedCommit(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  return REPORTED_COMMIT.test(text) ? text : null;
}

/**
 * Whether what the deployment reports confirms the commit a caller claimed.
 * One direction only: the reading may abbreviate the claim, never the reverse.
 */
function deploymentConfirms(claimed: string, reported: string): boolean {
  const claim = claimedCommit(claimed);
  const reading = reportedCommit(reported);
  if (claim === null || reading === null) return false;
  return claim.startsWith(reading);
}

/** Why a finish naming no commit is refused on a batch that recorded nothing serving when it opened. */
export const NOTHING_TO_COMPARE =
  'nothing recorded what was serving when this batch opened, so a finish naming no commit has ' +
  'nothing to compare the live build against — call finish again with `commit`, the whole sha ' +
  'you pushed.';

/** The one sentence a claim that is not a whole object name is refused with. */
export function notAWholeCommit(raw: string, identity: string | null): string {
  const reported = identity === null ? '' : ` The deployment reports \`${identity}\`.`;
  return (
    `\`${raw.trim()}\` is not a whole commit — a release names all 40 hexadecimal characters ` +
    `of the sha, because a shorter value is confirmed by every commit it is a prefix of and so ` +
    `says how much of an identity the caller wanted checked rather than which commit is ` +
    `serving.${reported}`
  );
}

/** Whether what a batch found serving already carries a roster issue's merge —
 *  any one. Sufficient, not complete: ancestry needs ISS-1129's provider. */
export function liveCarriesRoster(
  commitBefore: string | null,
  mergedCommits: Array<string | null>,
): boolean {
  if (commitBefore === null) return false;
  return mergedCommits.some((sha) => sha !== null && deploymentConfirms(sha, commitBefore));
}

interface ServingNowArgs {
  cfg: VerifyConfig;
  /** The whole sha the caller says production is serving. */
  expected: string;
}

/** Like {@link VerifyOutcome}, except the probe readings survive a GREEN: a recorded release has
 *  no deploy it watched to point at, so the readings ARE the record. */
export type ServingNowOutcome =
  | { ok: true; identity: string; health: 'up'; readings: string[] }
  | {
      ok: false;
      reason: string;
      live: string | null;
      health: 'up' | 'down';
      identity: string | null;
      readings: string[];
    };

/**
 * Whether the application is serving this commit RIGHT NOW, in one read: a release that already
 * happened has nothing to wait for, and {@link verifyDeployed}'s polling would turn a false claim
 * into a five-minute wait and the same refusal.
 */
export async function verifyServingNow(args: ServingNowArgs): Promise<ServingNowOutcome> {
  const state = await readLiveState(args.cfg);
  const claimed = claimedCommit(args.expected);
  if (claimed === null) {
    return { ...failureFor(state, null, null, args.expected), readings: state.readings };
  }
  if (state.health === 'up' && state.identity !== null) {
    if (deploymentConfirms(claimed, state.identity)) {
      return { ok: true, health: 'up', identity: state.identity, readings: state.readings };
    }
    return {
      ok: false,
      reason: `the application is healthy and serving ${state.identity}; this record claims ${claimed}`,
      live: state.identity,
      health: 'up',
      identity: state.identity,
      readings: state.readings,
    };
  }
  return { ...failureFor(state, null, null), readings: state.readings };
}
