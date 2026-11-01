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
function reportedCommit(raw: string): string | null {
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
