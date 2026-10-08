import { logger } from '../logger.js';

export interface VerifyProbe {
  url: string;
  /** Dot path into the JSON body. Omitted → the whole body, trimmed. */
  commitPath?: string | undefined;
}

export interface VerifyConfig {
  probes: VerifyProbe[];
  /** Consecutive recorded readings that must agree before a finish believes them. Default 2. */
  stableReads?: number;
}

export function probesKeyOf(cfg: VerifyConfig): string {
  return JSON.stringify(cfg.probes.map((p) => [p.url, p.commitPath ?? null]).sort());
}

export function parseVerifyConfig(raw: unknown): VerifyConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.probes)) return null;
  const probes = obj.probes
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => ({
      url: typeof p.url === 'string' ? p.url : '',
      commitPath: typeof p.commitPath === 'string' ? p.commitPath : undefined,
    }))
    .filter((p) => p.url.length > 0);
  if (probes.length === 0) return null;
  return {
    probes,
    stableReads: typeof obj.stableReads === 'number' ? obj.stableReads : 2,
  };
}

/** Declared probe urls no request could be made to: a declaration defect rather than an outage (ISS-1127). */
export function invalidProbeUrls(cfg: VerifyConfig): string[] {
  return cfg.probes.map((p) => p.url).filter((url) => !URL.canParse(url));
}

function pluck(body: unknown, path: string | undefined): string | null {
  if (path === undefined) return typeof body === 'string' ? body.trim() : null;
  let cur: unknown = body;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : null;
}

/** One probe's answer: `unreachable` and `http-error` failed to answer, `unparseable` and `no-commit`
 *  answered with no commit; kept apart so a `commitPath` typo is not read as an outage. */
export type ProbeReading =
  | { kind: 'commit'; commit: string }
  | { kind: 'no-commit' }
  | { kind: 'unparseable' }
  | { kind: 'http-error'; status: number }
  | { kind: 'unreachable'; detail: string };

/** Whether this reading says the application answered at all. */
export function probeIsHealthy(r: ProbeReading): boolean {
  return r.kind !== 'unreachable' && r.kind !== 'http-error';
}

export function describeProbeReading(probe: VerifyProbe, r: ProbeReading): string {
  switch (r.kind) {
    case 'commit':
      return `${probe.url} -> ${r.commit}`;
    case 'no-commit':
      return `${probe.url} answered 200 and \`${probe.commitPath ?? '(whole body)'}\` held no commit`;
    case 'unparseable':
      return `${probe.url} answered 200 with a body that is not JSON`;
    case 'http-error':
      return `${probe.url} answered http ${r.status}`;
    case 'unreachable':
      return `${probe.url} is unreachable (${r.detail})`;
  }
}

export const PROBE_REQUEST_CAP_MS = 10_000;

/** One probe, read as `unreachable` once `timeoutMs` (never more than the cap) runs out. */
export async function readProbe(
  probe: VerifyProbe,
  timeoutMs: number = PROBE_REQUEST_CAP_MS,
): Promise<ProbeReading> {
  const url = new URL(probe.url);
  url.searchParams.set('_forge_cb', String(Math.random()).slice(2));
  try {
    const res = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, PROBE_REQUEST_CAP_MS))),
    });
    if (!res.ok) return { kind: 'http-error', status: res.status };
    const text = await res.text();
    if (probe.commitPath === undefined) {
      const trimmed = text.trim();
      return trimmed ? { kind: 'commit', commit: trimmed } : { kind: 'no-commit' };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: 'unparseable' };
    }
    const commit = pluck(body, probe.commitPath);
    return commit == null ? { kind: 'no-commit' } : { kind: 'commit', commit };
  } catch (err) {
    logger.debug({ err, url: probe.url }, 'release-verify: probe unreachable');
    return { kind: 'unreachable', detail: err instanceof Error ? err.message : 'unknown error' };
  }
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
 * every probe agreeing on one commit. A fleet half on the new build is healthy with no identity.
 */
export async function readLiveState(cfg: VerifyConfig): Promise<LiveState> {
  const reads = await Promise.all(cfg.probes.map((p) => readProbe(p)));
  const readings = reads.map((r, i) => describeProbeReading(cfg.probes[i] as VerifyProbe, r));
  const unhealthy = reads
    .map((r, i) => (probeIsHealthy(r) ? null : (readings[i] ?? null)))
    .filter((s): s is string => s !== null);
  const unidentified = reads
    .map((r, i) => (probeIsHealthy(r) && r.kind !== 'commit' ? (readings[i] ?? null) : null))
    .filter((s): s is string => s !== null);

  const answeredBy = reads.flatMap((r, i) =>
    r.kind === 'commit' ? [{ url: (cfg.probes[i] as VerifyProbe).url, commit: r.commit }] : [],
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
 * else, the commit serving before anything moved, and reads it once. It throws
 * rather than reading: `readProbe` builds its `URL` above the `try`, so an
 * unparseable probe url rejects out of here instead of becoming a reading.
 * `verifyServingNow` and a look throw the same way. The doors screen ahead of
 * them — `createReleaseBatch` and `recordPerformedRelease` through
 * `collectReleaseBlockers`, a look and a finish through `finishVerification` —
 * which is why that throw is a 409 and not a 500 (ISS-1127, ISS-1129 F3, F4).
 */
export async function readLiveCommit(cfg: VerifyConfig): Promise<string | null> {
  return (await readLiveState(cfg)).identity;
}

/** Whether one reading satisfies the gate: a claim is the whole proof where one
 *  is made, and only a claimless gate asks that the build left `commitBefore` —
 *  asking both leaves a batch opened after its own release stuck (ISS-1199). */
export function readingSatisfies(
  live: string | null,
  commitBefore: string | null,
  claim: string | null,
): boolean {
  if (live === null) return false;
  // With no claim and nothing recorded before, every reading would look like a move.
  if (claim === null) return commitBefore !== null && live !== commitBefore;
  return deploymentConfirms(claim, live);
}

/**
 * Why one reading does not satisfy the gate: health, then identity, then the claim — which is only
 * judgeable once there is a reading to judge it against.
 */
export function failureFor(
  state: LiveState,
  commitBefore: string | null,
  claim: string | null,
  unusableClaim: string | null = null,
): Omit<Extract<ServingNowOutcome, { ok: false }>, 'readings'> {
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
  return { ...base, health: 'up', reason: `the live build is ${state.identity}` };
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
export function deploymentConfirms(claimed: string, reported: string): boolean {
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

/** Whether what a batch found serving, at any live binding, already carries a roster issue's
 *  merge — any one. Sufficient, not complete: ancestry needs ISS-1129's provider. */
export function liveCarriesRoster(
  commitsBefore: ReadonlyArray<string | null>,
  mergedCommits: Array<string | null>,
): boolean {
  return commitsBefore.some(
    (before) =>
      before !== null &&
      mergedCommits.some((sha) => sha !== null && deploymentConfirms(sha, before)),
  );
}

export interface ServingNowArgs {
  cfg: VerifyConfig;
  /** The whole sha the caller says production is serving. */
  expected: string;
}

/**
 * One reading's verdict on a claimed commit. The probe readings travel on both arms: a recorded
 * release has no deploy this server watched to point at, so the readings ARE the record.
 */
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
 * Whether the application is serving this commit RIGHT NOW, in one read.
 *
 * A release that already happened has nothing to wait for, so the commit it
 * names is judged against the one reading this takes.
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
