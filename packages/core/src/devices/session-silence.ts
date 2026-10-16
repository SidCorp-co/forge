import { getLoopThresholds } from '../jobs/loop-monitor-thresholds.js';
import { PIPELINE_SESSION_KINDS } from '../jobs/session-kinds.js';
import { MASTER_SESSION_METADATA_TYPE, RUN_SESSION_METADATA_TYPE } from './run-session-keys.js';

export const SESSION_SILENCE_TIMEOUT_MS = 10 * 60 * 1000;

export const SESSION_SILENCE_TIMEOUT_S = Math.floor(SESSION_SILENCE_TIMEOUT_MS / 1000);

/** The least the one-shot sweep waits on a session whose box's runner still answers. */
export const ONE_SHOT_DEVICE_GRACE_FLOOR_MS = 20 * 60_000;

export function oneShotDeviceGraceMs(heartbeatMs: number): number {
  return Math.max(heartbeatMs, ONE_SHOT_DEVICE_GRACE_FLOOR_MS);
}

const HEARTBEAT_REAPED_KINDS: ReadonlySet<string> = new Set(PIPELINE_SESSION_KINDS);

/** A live session on the same jobless one-shot run, the subject included at `leadMs` 0. */
export interface OneShotSibling {
  /** How much later than the subject it was last heard. */
  leadMs: number;
  runnerAnswers: boolean;
  parked: boolean;
}

export interface SilenceSubject {
  kind: string;
  runtimeState?: string | null;
  metadata?: unknown;
  /** A master: how much later than it the latest live child it owns was heard. */
  childLeadMs?: number | null;
  /** The live sessions of its run, where the run is a running one-shot run with no job. */
  oneShot?: readonly OneShotSibling[] | null;
}

/** As the loop monitor's `metadata -> key IS NOT NULL` reads it: the key present, a JSON null included. */
function carries(metadata: unknown, key: string): boolean {
  return metadata !== null && typeof metadata === 'object' && Object.hasOwn(metadata, key);
}

/**
 * How long a running session may go unheard before core ends it, or `null` where no silence does:
 * built on the constants the reapers read, so a screen counting to it says what core will do.
 */
export function silenceLimitMs(session: SilenceSubject): number | null {
  const { heartbeatMs } = getLoopThresholds();
  const limits: number[] = [];
  if (session.kind === RUN_SESSION_METADATA_TYPE) limits.push(SESSION_SILENCE_TIMEOUT_MS);
  if (session.kind === MASTER_SESSION_METADATA_TYPE) {
    limits.push(SESSION_SILENCE_TIMEOUT_MS + Math.max(0, session.childLeadMs ?? 0));
  }
  const heartbeatReaped =
    session.runtimeState !== 'awaiting_input' &&
    (HEARTBEAT_REAPED_KINDS.has(session.kind) ||
      carries(session.metadata, 'escalation') ||
      carries(session.metadata, 'agentChat'));
  if (heartbeatReaped) limits.push(heartbeatMs);
  const siblings = session.oneShot ?? [];
  if (siblings.length > 0 && !siblings.some((t) => t.parked)) {
    // The sweep closes the run once no live session on it is fresh, so the last one heard sets it.
    limits.push(
      Math.max(
        ...siblings.map(
          (t) => t.leadMs + (t.runnerAnswers ? oneShotDeviceGraceMs(heartbeatMs) : heartbeatMs),
        ),
      ),
    );
  }
  return limits.length === 0 ? null : Math.round(Math.min(...limits));
}
