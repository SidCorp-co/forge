/**
 * What a box says about the binaries its panes need and it cannot resolve: `forge-runner`, `claude`
 * and `node`. The box decides what is missing (`terminal/pane_env.rs:missing_binaries`); core keeps
 * the newest picture and shows it to the device's owner.
 */

import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { utf16String } from '../lib/utf16-string.js';

/** The box's own bounds: `runner-proto/src/binaries.rs` `WIRE_MAX` and `DETAIL_UNITS`. */
export const BINARY_WIRE_MAX = 8;
export const BINARY_DETAIL_UNITS = 600;

const missingSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    detail: utf16String(BINARY_DETAIL_UNITS),
  })
  .strict();

const binaryReportSchema = z
  .object({ missing: z.array(missingSchema).max(BINARY_WIRE_MAX) })
  .strict();

export type BinaryReport = z.infer<typeof binaryReportSchema>;

/** What every surface shows. `null` where this box has never reported its binaries. */
export type DeviceBinaries = BinaryReport & { receivedAt: string };

export function storedBinaryReport(report: BinaryReport, now: Date): DeviceBinaries {
  return { ...report, receivedAt: now.toISOString() };
}

/**
 * Liveness is the heartbeat's kernel job and this report rides along, so a report core cannot read
 * is refused by name in the response and nothing is stored, never a bad request that would take the
 * box offline with it — the rule `heartbeatGate` holds for the gate.
 */
export function heartbeatBinaries(
  binaries: unknown,
  deviceId: string,
): { report?: BinaryReport; ack: Record<string, unknown> } {
  if (binaries === undefined) return { ack: {} };
  const parsed = binaryReportSchema.safeParse(binaries);
  if (parsed.success) {
    return { report: parsed.data, ack: { binaries: { accepted: true } } };
  }
  const first = parsed.error.issues[0];
  const at = first?.path.length ? `binaries.${first.path.join('.')}` : 'binaries';
  const reason = `${at}: ${first?.message ?? 'not a binary report core can read'}`;
  logger.warn(
    { deviceId, reason },
    'heartbeat: this box sent a binary report core cannot read, so nothing was stored',
  );
  return { ack: { binaries: { accepted: false, reason } } };
}

export function withDeviceBinaries<T extends { binaryReport?: unknown }>(
  rows: T[],
): Array<Omit<T, 'binaryReport'> & { binaries: DeviceBinaries | null }> {
  return rows.map(({ binaryReport, ...row }) => ({
    ...row,
    binaries: readDeviceBinaries(binaryReport),
  }));
}

function readDeviceBinaries(stored: unknown): DeviceBinaries | null {
  if (stored === null || typeof stored !== 'object') return null;
  const { receivedAt, ...report } = stored as { receivedAt?: unknown };
  const parsed = binaryReportSchema.safeParse(report);
  if (!parsed.success || typeof receivedAt !== 'string') return null;
  return { ...parsed.data, receivedAt };
}
