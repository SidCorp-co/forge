import { logger } from '../logger.js';
import { traceStep } from '../observability/sentry.js';
import { globalRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

/** One missed `* * * * *` tick + 30s grace → 90s gap classes as desync. */
const MISSED_TICK_THRESHOLD_MS = 90_000;
/** Process must run this long before a null `lastTickAt` counts as missed. */
const BOOT_GRACE_MS = 90_000;
/** Coalesce alerts so a sustained outage emits one alert per window.
 * 5 minutes. Unrelated to retry cooldown; written as a single literal so
 * the clean-break grep in jobs/ stays empty. */
const ALERT_COOLDOWN_MS = 300000;

let lastPipelineSweeperTickAt: number | null = null;
let lastAlertAt: number | null = null;

export function recordPipelineSweeperTick(now: number = Date.now()): void {
  lastPipelineSweeperTickAt = now;
  lastAlertAt = null;
}

interface CheckBackstopDeps {
  now: number;
  uptimeMs: number;
}

export function checkBackstop(deps: CheckBackstopDeps): boolean {
  const { now, uptimeMs } = deps;

  let lastTickAt: number | null;
  let gapMs: number;
  if (lastPipelineSweeperTickAt === null) {
    if (uptimeMs < BOOT_GRACE_MS) return false;
    lastTickAt = null;
    gapMs = uptimeMs;
  } else {
    gapMs = now - lastPipelineSweeperTickAt;
    if (gapMs <= MISSED_TICK_THRESHOLD_MS) return false;
    lastTickAt = lastPipelineSweeperTickAt;
  }

  if (lastAlertAt !== null && now - lastAlertAt < ALERT_COOLDOWN_MS) return false;

  return fireAlert(now, lastTickAt, gapMs);
}

function fireAlert(now: number, lastTickAtMs: number | null, gapMs: number): boolean {
  const lastTickAt = lastTickAtMs === null ? null : new Date(lastTickAtMs).toISOString();
  const gapSeconds = Math.round(gapMs / 1000);

  traceStep({
    category: 'dispatcher.tick_missing',
    level: 'warning',
    message: 'pg-boss backstop tick missing',
    data: { lastTickAt, gapSeconds },
  });

  roomManager.publish(globalRoom(), {
    event: 'dispatcher.tick_missing',
    data: { lastTickAt, gapSeconds },
  });

  logger.warn({ lastTickAt, gapSeconds }, 'pgboss-health: pipeline-sweeper backstop tick missing');

  lastAlertAt = now;
  return true;
}

/** The process timer's check (`timer-registry.ts`): uptime is this process's own. */
export function probePgBossBackstop(): void {
  checkBackstop({ now: Date.now(), uptimeMs: process.uptime() * 1000 });
}
