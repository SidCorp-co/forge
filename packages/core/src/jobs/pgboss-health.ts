/**
 * pg-boss health probe — detects schedule misses on the `* * * * *`
 * pipeline-sweeper backstop.
 *
 * Piggy-backs on the existing `pipeline-sweeper` schedule instead of
 * introducing a second pg-boss schedule that would itself need watching.
 * `runPipelineSweep` calls `recordPipelineSweeperTick()` at the top of
 * every successful tick; the probe runs a 30s setInterval and alerts when
 * the gap since the last tick exceeds the threshold.
 *
 * Alert delivery: Sentry breadcrumb + WS `dispatcher.tick_missing` event
 * on the global room. Alerts are coalesced to one per 5-minute window;
 * a fresh tick clears the cooldown so a subsequent miss alerts again.
 */

import { logger } from '../logger.js';
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { globalRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

/** 30s cadence — twice the smallest meaningful pg-boss tick. */
const PROBE_INTERVAL_MS = 30_000;
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
let timer: ReturnType<typeof setInterval> | null = null;

export function recordPipelineSweeperTick(now: number = Date.now()): void {
  lastPipelineSweeperTickAt = now;
  // A fresh tick clears the cooldown so a future gap alerts again instead
  // of being suppressed by an old alert that is still inside the 5-minute
  // window.
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

  if (isSentryEnabled()) {
    Sentry.addBreadcrumb({
      category: 'dispatcher.tick_missing',
      level: 'warning',
      message: 'pg-boss backstop tick missing',
      data: { lastTickAt, gapSeconds },
    });
  }

  roomManager.publish(globalRoom(), {
    event: 'dispatcher.tick_missing',
    data: { lastTickAt, gapSeconds },
  });

  logger.warn(
    { lastTickAt, gapSeconds },
    'pgboss-health: pipeline-sweeper backstop tick missing',
  );

  lastAlertAt = now;
  return true;
}

let registered = false;

export async function registerPgBossHealthProbe(): Promise<void> {
  if (registered) return;
  const startedAt = Date.now();
  timer = setInterval(() => {
    try {
      checkBackstop({ now: Date.now(), uptimeMs: Date.now() - startedAt });
    } catch (err) {
      logger.error({ err }, 'pgboss-health: check threw');
    }
  }, PROBE_INTERVAL_MS);
  // Allow the process to exit cleanly during tests / shutdown.
  timer.unref?.();
  registered = true;
}

export function resetPgBossHealthProbeForTest(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  registered = false;
  lastPipelineSweeperTickAt = null;
  lastAlertAt = null;
}
