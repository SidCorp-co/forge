import { getLoopThresholds } from '../jobs/loop-monitor-thresholds.js';
import { PIPELINE_SESSION_KINDS } from '../jobs/session-kinds.js';
import { MASTER_SESSION_METADATA_TYPE, RUN_SESSION_METADATA_TYPE } from './run-session-keys.js';

export const SESSION_SILENCE_TIMEOUT_MS = 10 * 60 * 1000;

export const SESSION_SILENCE_TIMEOUT_S = Math.floor(SESSION_SILENCE_TIMEOUT_MS / 1000);

/** The kinds the loop monitor fails on a stopped heartbeat (`reapZombieSessions`). */
const HEARTBEAT_REAPED_KINDS: ReadonlySet<string> = new Set(PIPELINE_SESSION_KINDS);

export interface SilenceSubject {
  kind: string;
  runtimeState?: string | null;
  metadata?: unknown;
}

function carries(metadata: unknown, key: string): boolean {
  if (metadata === null || typeof metadata !== 'object') return false;
  const value = (metadata as Record<string, unknown>)[key];
  return value !== undefined && value !== null;
}

/**
 * How long a running session may go unheard before core ends it, or `null` where no silence does:
 * built on the constants the reapers read, so a screen counting to it says what core will do.
 */
export function silenceLimitMs(session: SilenceSubject): number | null {
  if (session.kind === RUN_SESSION_METADATA_TYPE || session.kind === MASTER_SESSION_METADATA_TYPE) {
    return SESSION_SILENCE_TIMEOUT_MS;
  }
  if (session.runtimeState === 'awaiting_input') return null;
  const heartbeatReaped =
    HEARTBEAT_REAPED_KINDS.has(session.kind) ||
    carries(session.metadata, 'escalation') ||
    carries(session.metadata, 'agentChat');
  return heartbeatReaped ? getLoopThresholds().heartbeatMs : null;
}
