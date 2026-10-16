import { terminalAgentSessionStatuses } from '../db/session-vocabulary.js';
import {
  CHAT_IDLE_CLOSE_MS,
  getLoopThresholds,
  oneShotDeviceGraceMs,
} from '../jobs/loop-monitor-thresholds.js';
import { CLIENT_SESSION_KINDS, PIPELINE_SESSION_KINDS } from '../jobs/session-kinds.js';
import { LIVE_SESSION_STATUSES } from '../lifecycle/status-sets.js';
import { MASTER_SESSION_METADATA_TYPE, RUN_SESSION_METADATA_TYPE } from './run-session-keys.js';

export const SESSION_SILENCE_TIMEOUT_MS = 10 * 60 * 1000;

export const SESSION_SILENCE_TIMEOUT_S = Math.floor(SESSION_SILENCE_TIMEOUT_MS / 1000);

const PIPELINE_KINDS: ReadonlySet<string> = new Set(PIPELINE_SESSION_KINDS);
const CLIENT_KINDS: ReadonlySet<string> = new Set(CLIENT_SESSION_KINDS);
const LIVE: ReadonlySet<string> = new Set(LIVE_SESSION_STATUSES);
const TERMINAL: ReadonlySet<string> = new Set(terminalAgentSessionStatuses);

/** A live session on the same jobless one-shot run, the subject included. */
export interface OneShotSibling {
  beatAt: number;
  /** When its box's runner was last heard, `null` where the box has none. */
  runnerSeenAt: number | null;
  parked: boolean;
}

/** Times are epoch milliseconds, as the reapers' own rows hold them. */
export interface SilenceSubject {
  kind: string;
  status: string;
  runtimeState?: string | null;
  /** The keys the reapers read: `escalation`, `agentChat`, `acked`, `source`. */
  metadata?: unknown;
  hasClient?: boolean;
  lastHeartbeatAt: number | null;
  startedAt: number | null;
  updatedAt: number;
  createdAt: number;
  dispatchedAt?: number | null;
  parked?: boolean;
  hasJob?: boolean;
  /** The project's residency, park grace included. */
  residencyMs?: number;
  latestChildBeatAt?: number | null;
  oneShot?: { runStartedAt: number; sessions: readonly OneShotSibling[] } | null;
}

function field(metadata: unknown, key: string): { present: boolean; value: unknown } {
  if (metadata === null || typeof metadata !== 'object' || !Object.hasOwn(metadata, key)) {
    return { present: false, value: undefined };
  }
  return { present: true, value: (metadata as Record<string, unknown>)[key] };
}

/** The loop monitor's heartbeat hop, with the baseline it falls back to when no heartbeat came. */
function heartbeatHop(s: SilenceSubject, hb: number): number | null {
  const reaped =
    PIPELINE_KINDS.has(s.kind) ||
    field(s.metadata, 'escalation').present ||
    field(s.metadata, 'agentChat').present;
  if (s.status !== 'running' || s.runtimeState === 'awaiting_input' || !reaped) return null;
  if (s.lastHeartbeatAt !== null) return s.lastHeartbeatAt + hb;
  return Math.max(s.startedAt ?? s.createdAt, s.updatedAt) + hb;
}

function queueHop(s: SilenceSubject, queueMs: number, hb: number): number | null {
  if (s.status !== 'queued' || !PIPELINE_KINDS.has(s.kind)) return null;
  if (s.lastHeartbeatAt !== null) return s.lastHeartbeatAt + hb;
  return (s.dispatchedAt ?? s.createdAt) + queueMs;
}

function noClientHop(s: SilenceSubject, hb: number, ackFastMs: number): number | null {
  if (s.status !== 'running' || s.hasClient !== false || !CLIENT_KINDS.has(s.kind)) return null;
  const acked = field(s.metadata, 'acked').value;
  const ends = [s.lastHeartbeatAt === null ? s.createdAt + hb : s.lastHeartbeatAt + hb];
  if (acked === true || acked === 'true') ends.push((s.dispatchedAt ?? s.createdAt) + ackFastMs);
  return Math.min(...ends);
}

function oneShotSweep(s: SilenceSubject, hb: number): number | null {
  const run = s.oneShot;
  if (!run || !LIVE.has(s.status) || run.sessions.some((t) => t.parked)) return null;
  const grace = oneShotDeviceGraceMs(hb);
  return Math.max(
    run.runStartedAt + hb,
    ...run.sessions.map((t) =>
      Math.max(
        t.beatAt + hb,
        t.runnerSeenAt === null ? 0 : Math.min(t.beatAt + grace, t.runnerSeenAt + hb),
      ),
    ),
  );
}

/** When core ends this session if nothing is heard from it, or `null` where silence never does. */
export function silenceDeadline(s: SilenceSubject): number | null {
  const { heartbeatMs: hb, queueMs, ackFastMs } = getLoopThresholds();
  const ownBeat = s.lastHeartbeatAt ?? s.startedAt ?? s.createdAt;
  const lastHeard = s.lastHeartbeatAt ?? s.startedAt ?? s.updatedAt ?? s.createdAt;
  const ends: Array<number | null> = [
    heartbeatHop(s, hb),
    queueHop(s, queueMs, hb),
    noClientHop(s, hb, ackFastMs),
    oneShotSweep(s, hb),
  ];
  if (s.kind === RUN_SESSION_METADATA_TYPE && s.status === 'running') {
    ends.push(ownBeat + SESSION_SILENCE_TIMEOUT_MS);
  }
  if (s.kind === MASTER_SESSION_METADATA_TYPE && !TERMINAL.has(s.status)) {
    ends.push(Math.max(ownBeat, s.latestChildBeatAt ?? ownBeat) + SESSION_SILENCE_TIMEOUT_MS);
  }
  if (s.status === 'running' && s.runtimeState === 'awaiting_input' && !s.parked) {
    if (s.residencyMs !== undefined) ends.push((s.lastHeartbeatAt ?? s.createdAt) + s.residencyMs);
  }
  if (LIVE.has(s.status) && s.startedAt !== null && !s.hasJob) {
    if (field(s.metadata, 'source').value !== 'schedule.run')
      ends.push(lastHeard + CHAT_IDLE_CLOSE_MS);
  }
  const known = ends.filter((e): e is number => e !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/** Counted from where the screens count: the heartbeat, else the start, else the last update. */
export function silenceLimitMs(s: SilenceSubject): number | null {
  const deadline = silenceDeadline(s);
  if (deadline === null) return null;
  const counted = s.lastHeartbeatAt ?? s.startedAt ?? s.updatedAt ?? s.createdAt;
  return Math.max(0, Math.round(deadline - counted));
}
