/** ISS-1273 — the timing `jobs/loop-monitor.ts` reads from the environment and re-exports. */

import { JOB_HEARTBEAT_REAP_DEFAULT_MS } from '@forge/contracts/run-standing';

const QUEUE_TIMEOUT_MS_DEFAULT = 120_000;
const HEARTBEAT_TIMEOUT_MS_DEFAULT = JOB_HEARTBEAT_REAP_DEFAULT_MS;
const ACK_TIMEOUT_MS_DEFAULT = 3 * 60_000;
const MIN_TIMEOUT_MS = 30_000;
const ACK_FAST_MS_DEFAULT = 90_000;

/** Result-hop quiet threshold: 60 min, because legit forge-release/forge-code merges run over 5
 *  between emissions. The demoted stale-detector alarm derives its margin from it. */
export const RESULT_QUIET_MINUTES = 60;

function readTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_TIMEOUT_MS ? n : fallback;
}

export function getLoopThresholds(): {
  queueMs: number;
  heartbeatMs: number;
  ackMs: number;
  ackFastMs: number;
} {
  return {
    queueMs: readTimeoutEnv('PIPELINE_QUEUE_TIMEOUT_MS', QUEUE_TIMEOUT_MS_DEFAULT),
    heartbeatMs: readTimeoutEnv('PIPELINE_HEARTBEAT_TIMEOUT_MS', HEARTBEAT_TIMEOUT_MS_DEFAULT),
    ackMs: readTimeoutEnv('PIPELINE_NEVER_CLAIMED_MS', ACK_TIMEOUT_MS_DEFAULT),
    ackFastMs: readTimeoutEnv('PIPELINE_ACK_FAST_MS', ACK_FAST_MS_DEFAULT),
  };
}
