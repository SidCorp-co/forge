/**
 * The device's Forge Box health (ISS-1276, ADR 0015): the headroom, the modes it can serve and
 * their cost, and the boxes it holds, reported on each heartbeat as `box`. The device reports the
 * facts and its own reserves; core compares and decides (`run-slots.ts:slotsFor`, through
 * `run-slots-read.ts`). A malformed report is refused by name in the heartbeat's ack and stored as
 * nothing, so a box request then waits on "unmeasured" rather than on a guess.
 */

import {
  type BoxCost,
  type BoxHealthReport,
  type BoxModeReport,
  boxHealthReportSchema,
} from '@forge/contracts/box-wire';
import { BOX_LIMITS, type BoxMode } from '@forge/contracts/boxes';
import { logger } from '../lib/logger.js';

export function heartbeatBoxHealth(
  box: unknown,
  deviceId: string,
): { report?: BoxHealthReport; ack: Record<string, unknown> } {
  if (box === undefined) return { ack: {} };
  const parsed = boxHealthReportSchema.safeParse(box);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first?.path.length ? `box.${first.path.join('.')}` : 'box';
    const reason = `${at}: ${first?.message ?? 'not a box health report core can read'}`;
    logger.warn(
      { deviceId, reason },
      'heartbeat: this box sent a box health report core cannot read, so nothing was stored',
    );
    return { ack: { box: { accepted: false, reason } } };
  }
  return { report: parsed.data, ack: { box: { accepted: true } } };
}

/** The health as stored, with when core heard it; null where the device never reported one. */
export interface StoredBoxHealth {
  report: BoxHealthReport;
  receivedAt: Date;
}

export function readStoredBoxHealth(
  stored: unknown,
  receivedAt: Date | null,
): StoredBoxHealth | null {
  if (stored === null || stored === undefined || receivedAt === null) return null;
  const parsed = boxHealthReportSchema.safeParse(stored);
  return parsed.success ? { report: parsed.data, receivedAt } : null;
}

/** The health to allocate from, or why there is none to trust. */
export function freshBoxHealth(
  stored: StoredBoxHealth | null,
  now: Date,
): BoxHealthReport | { unmeasured: string } {
  if (stored === null) {
    return { unmeasured: 'this device has not reported its box health yet' };
  }
  const age = Math.round((now.getTime() - stored.receivedAt.getTime()) / 1000);
  if (age > BOX_LIMITS.healthFreshSeconds) {
    return {
      unmeasured: `this device's box health was last reported ${age}s ago, past the ${BOX_LIMITS.healthFreshSeconds}s a measurement is trusted`,
    };
  }
  return stored.report;
}

/** One mode as the device last reported it, or null where it never named it. */
export function modeReportOf(stored: StoredBoxHealth | null, mode: string): BoxModeReport | null {
  return stored?.report.modes.find((m) => m.mode === mode) ?? null;
}

export const NO_COST: BoxCost = { memoryMb: 0, diskMb: 0, cpuCores: 0 };

/** What a box of `mode` costs on this device: its reported cost, or nothing where none was named. */
export function costOf(stored: StoredBoxHealth | null, mode: BoxMode): BoxCost {
  return modeReportOf(stored, mode)?.cost ?? NO_COST;
}
