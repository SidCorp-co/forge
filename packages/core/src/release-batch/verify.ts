import { logger } from '../logger.js';

export interface VerifyProbe {
  url: string;
  /** Dot path into the JSON body. Omitted → the whole body, trimmed. */
  commitPath?: string | undefined;
}

export interface VerifyConfig {
  probes: VerifyProbe[];
  /** Give up after this long. Default 300s. */
  timeoutSeconds?: number;
  /** Consecutive identical reads required before believing it. Default 2. */
  stableReads?: number;
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
    timeoutSeconds: typeof obj.timeoutSeconds === 'number' ? obj.timeoutSeconds : 300,
    stableReads: typeof obj.stableReads === 'number' ? obj.stableReads : 2,
  };
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

/**
 * One probe's answer, kept as the shape it had: `unreachable` and `http-error`
 * are a failure to answer, `unparseable` and `no-commit` are an answer with no
 * commit. The four stay apart so a `commitPath` typo is not read as an outage.
 */
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

export async function readProbe(probe: VerifyProbe): Promise<ProbeReading> {
  const url = new URL(probe.url);
  url.searchParams.set('_forge_cb', String(Math.random()).slice(2));
  try {
    const res = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      redirect: 'follow',
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
  /** One line per probe, in declaration order, whatever the outcome. */
  readings: string[];
  /** The probes whose reading is not a commit, by what went wrong. */
  unhealthy: string[];
  unidentified: string[];
  /** Set when every probe answered a commit and they disagree. */
  disagreement: string[] | null;
}

/**
 * One read of every probe, kept as two answers: health is every probe
 * answering, identity is every probe agreeing on one commit. A fleet half on
 * the new build is healthy and has no identity, so the two stay apart.
 */
export async function readLiveState(cfg: VerifyConfig): Promise<LiveState> {
  const reads = await Promise.all(cfg.probes.map(readProbe));
  const readings = reads.map((r, i) => describeProbeReading(cfg.probes[i] as VerifyProbe, r));
  const unhealthy = reads
    .map((r, i) => (probeIsHealthy(r) ? null : (readings[i] ?? null)))
    .filter((s): s is string => s !== null);
  const unidentified = reads
    .map((r, i) => (probeIsHealthy(r) && r.kind !== 'commit' ? (readings[i] ?? null) : null))
    .filter((s): s is string => s !== null);

  const commits = reads.filter((r): r is { kind: 'commit'; commit: string } => r.kind === 'commit');
  const agreed =
    commits.length === reads.length && commits.length > 0
      ? commits.every((r) => r.commit === commits[0]?.commit)
        ? (commits[0]?.commit ?? null)
        : null
      : null;
  const disagreement =
    commits.length === reads.length && commits.length > 0 && agreed === null
      ? [...new Set(commits.map((r) => r.commit))]
      : null;

  return {
    health: unhealthy.length === 0 ? 'up' : 'down',
    identity: agreed,
    readings,
    unhealthy,
    unidentified,
    disagreement,
  };
}

/** One read of every probe, as the single commit the fleet agrees on. */
export async function readLiveCommit(cfg: VerifyConfig): Promise<string | null> {
  return (await readLiveState(cfg)).identity;
}

export type VerifyOutcome =
  | { ok: true; commit: string; health: 'up'; identity: string }
  | {
      ok: false;
      reason: string;
      live: string | null;
      health: 'up' | 'down';
      identity: string | null;
      readings: string[];
    };

export interface VerifyArgs {
  cfg: VerifyConfig;
  /** What was serving before the release started. */
  commitBefore: string | null;
  /** What the release says it pushed. */
  expected: string | null;
  /** Injected so the poll loop is testable without real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function verifyDeployed(args: VerifyArgs): Promise<VerifyOutcome> {
  const { cfg, commitBefore, expected } = args;
  const now = args.now ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (cfg.timeoutSeconds ?? 300) * 1000;
  const needed = cfg.stableReads ?? 2;

  let stable = 0;
  let last: string | null = null;
  let state: LiveState = {
    health: 'down',
    identity: null,
    readings: [],
    unhealthy: [],
    unidentified: [],
    disagreement: null,
  };

  while (now() < deadline) {
    state = await readLiveState(cfg);
    const live = state.identity;
    const acceptable =
      live != null && live !== commitBefore && (expected == null || live === expected);
    stable = acceptable && live === last ? stable + 1 : acceptable ? 1 : 0;
    last = live;
    if (stable >= needed && live != null) {
      return { ok: true, commit: live, health: 'up', identity: live };
    }
    if (now() >= deadline) break;
    await sleep(5000);
  }

  return { ...failureFor(state, commitBefore, expected), readings: state.readings };
}

/** Why the window closed red, health first and identity second. */
function failureFor(
  state: LiveState,
  commitBefore: string | null,
  expected: string | null,
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
  if (state.identity === commitBefore) {
    return {
      ...base,
      health: 'up',
      reason: `the live build is unchanged (${state.identity}) — the site is healthy and still serving the pre-release commit`,
    };
  }
  if (expected != null && state.identity !== expected) {
    return {
      ...base,
      health: 'up',
      reason: `live is ${state.identity}, the release pushed ${expected}`,
    };
  }
  return { ...base, health: 'up', reason: 'the live commit never held still' };
}

/** What a commit identity may look like: a git object name, whole or abbreviated. */
const COMMIT_SHAPE = /^[0-9a-f]{7,40}$/;

/**
 * One commit identity, or `null` where the value is not one. Seven is git's own
 * floor on an abbreviation and the floor here, so no four-character value can
 * agree with a fleet by accident.
 */
function normalizeCommit(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  return COMMIT_SHAPE.test(text) ? text : null;
}

/**
 * Whether two commit identities name the same commit: one is a prefix of the
 * other, because production reports an abbreviation and a caller holds the
 * whole sha. A value that is not a commit agrees with nothing, so `HEAD`, a tag
 * and an empty string are refused rather than compared.
 */
export function commitsAgree(a: string, b: string): boolean {
  const left = normalizeCommit(a);
  const right = normalizeCommit(b);
  if (left === null || right === null) return false;
  return left.startsWith(right) || right.startsWith(left);
}

export interface ServingNowArgs {
  cfg: VerifyConfig;
  /** The commit the caller says production is serving. */
  expected: string;
}

/**
 * Like {@link VerifyOutcome}, except that the probe readings survive a GREEN.
 *
 * `verifyDeployed` drops them on its ok arm because the deploy it watched is
 * its own evidence. A recorded release has no such act to point at: the
 * readings ARE the record, so they travel on both arms.
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
 * {@link verifyDeployed} answers a different question — did the deploy this run
 * started arrive — so it polls, and it refuses an identity equal to what was
 * serving before. A release that already happened has no before and nothing to
 * wait for: it either is live at the moment of the call or the record is not
 * earned. Polling here would turn a false claim into a five-minute wait and
 * then the same refusal.
 */
export async function verifyServingNow(args: ServingNowArgs): Promise<ServingNowOutcome> {
  const state = await readLiveState(args.cfg);
  const claimed = normalizeCommit(args.expected);
  if (claimed === null) {
    return {
      ok: false,
      reason: `\`${args.expected}\` is not a commit — a release record names the commit production is serving, as 7 to 40 hexadecimal characters`,
      live: state.identity,
      health: state.health,
      identity: state.identity,
      readings: state.readings,
    };
  }
  if (state.health === 'up' && state.identity !== null) {
    if (commitsAgree(claimed, state.identity)) {
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
