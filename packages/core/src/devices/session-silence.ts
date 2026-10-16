import { getLoopThresholds } from '../jobs/loop-monitor-thresholds.js';
import { PIPELINE_SESSION_KINDS } from '../jobs/session-kinds.js';
import { MASTER_SESSION_METADATA_TYPE, RUN_SESSION_METADATA_TYPE } from './run-session-keys.js';

export const SESSION_SILENCE_TIMEOUT_MS = 10 * 60 * 1000;

export const SESSION_SILENCE_TIMEOUT_S = Math.floor(SESSION_SILENCE_TIMEOUT_MS / 1000);

const HEARTBEAT_REAPED_KINDS: ReadonlySet<string> = new Set(PIPELINE_SESSION_KINDS);

export interface SilenceSubject {
  kind: string;
  runtimeState?: string | null;
  metadata?: unknown;
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
  const limits: number[] = [];
  if (session.kind === RUN_SESSION_METADATA_TYPE || session.kind === MASTER_SESSION_METADATA_TYPE) {
    limits.push(SESSION_SILENCE_TIMEOUT_MS);
  }
  const heartbeatReaped =
    session.runtimeState !== 'awaiting_input' &&
    (HEARTBEAT_REAPED_KINDS.has(session.kind) ||
      carries(session.metadata, 'escalation') ||
      carries(session.metadata, 'agentChat'));
  if (heartbeatReaped) limits.push(getLoopThresholds().heartbeatMs);
  return limits.length === 0 ? null : Math.min(...limits);
}
