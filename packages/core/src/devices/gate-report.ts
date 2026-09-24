/**
 * What a box says about its own declaration gate. The verdict stays the box's:
 * `daemon/degraded.rs` holds the one definition of a sustained rate (ISS-1192).
 */

import { z } from 'zod';
import { logger } from '../logger.js';

export const gateVerdicts = ['clear', 'marked', 'failing_open'] as const;
export type GateVerdict = (typeof gateVerdicts)[number];

/**
 * The producer's bounds in the producer's unit: `z.string().max()` counts UTF-16,
 * so `daemon/degraded.rs` clips in UTF-16 and not in scalars. Narrower than the box
 * emits refuses the whole report, and the box with most to say goes quiet. Both
 * numbers live in `gate-report.fixture.json` and each side asserts them (ISS-1192).
 */
export const WIRE_UNITS = 420;
export const WIRE_REASONS = 24;

const wire = () => z.string().max(WIRE_UNITS);

const lastMarkSchema = z
  .object({
    detail: wire(),
    source: wire().optional(),
    run: wire().optional(),
    runUnknown: wire().optional(),
    agent: wire().optional(),
    role: wire().optional(),
    toolUse: wire().optional(),
  })
  .strict();

const conditionSchema = z
  .object({
    verdict: z.enum(gateVerdicts),
    count: z.number().int().nonnegative().max(1_000_000),
    trimmed: z.boolean(),
    firstAt: z.number().int().nullable(),
    lastAt: z.number().int().nullable(),
    windowMs: z.number().int().nullable(),
    perDay: z.number().nullable(),
    sinceLastMs: z.number().int().nullable(),
    last: lastMarkSchema.nullable(),
    byReason: z
      .array(z.object({ reason: wire(), count: z.number().int().nonnegative() }).strict())
      .max(WIRE_REASONS),
  })
  .strict();

export const gateReportSchema = z.object({ degraded: conditionSchema }).strict();

export const gateConditionSchema = conditionSchema;

export type GateReport = z.infer<typeof gateReportSchema>;
export type GateCondition = z.infer<typeof conditionSchema>;

/** The stored column: what the box sent, and when core heard it. */
export type StoredGateReport = GateReport & { receivedAt: string };

export function storedGateReport(report: GateReport, now: Date): StoredGateReport {
  return { ...report, receivedAt: now.toISOString() };
}

export function readHeartbeatGate(gate: unknown): {
  report?: GateReport;
  refused?: string;
} {
  if (gate === undefined) return {};
  const parsed = gateReportSchema.safeParse(gate);
  if (parsed.success) return { report: parsed.data };
  const first = parsed.error.issues[0];
  const at = first?.path.length ? first.path.join('.') : 'gate';
  return { refused: `gate.${at}: ${first?.message ?? 'not a gate condition core can read'}` };
}

/**
 * Liveness is the heartbeat's kernel job and the gate rides along, so a field core
 * cannot read is refused by name in the response, never as a bad request that would
 * take the box offline with it (ISS-1192).
 */
export function heartbeatGate(
  gate: unknown,
  deviceId: string,
): { report?: GateReport; ack: Record<string, unknown> } {
  const read = readHeartbeatGate(gate);
  if (read.refused) {
    logger.warn(
      { deviceId, reason: read.refused },
      'heartbeat: this box sent a gate condition core cannot read, so nothing was stored',
    );
  }
  const ack =
    gate === undefined
      ? {}
      : { gate: read.refused ? { accepted: false, reason: read.refused } : { accepted: true } };
  return { ...(read.report ? { report: read.report } : {}), ack };
}

/** The run's own record of the gate it opened under, out of `pipeline_runs`.
 *  `null` is the box having sent none; one core cannot read says so. */
export type RunGate =
  | { read: 'ok'; condition: GateCondition }
  | { read: 'unreadable'; reason: string };

export const RUN_GATE_METADATA_KEY = 'gateAtOpen';

export function readRunGate(metadata: unknown, runId: string): RunGate | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const stored = (metadata as Record<string, unknown>)[RUN_GATE_METADATA_KEY];
  if (stored === undefined) return null;
  const parsed = conditionSchema.safeParse(stored);
  if (parsed.success) return { read: 'ok', condition: parsed.data };
  const reason = parsed.error.issues[0]?.message ?? 'not a gate condition core can read';
  logger.warn({ runId, reason }, 'pipeline run: this run carries a gate core cannot read');
  return { read: 'unreadable', reason };
}

export function withDeviceGate<T extends { gateReport?: unknown }>(
  rows: T[],
): Array<Omit<T, 'gateReport'> & { gate: DeviceGate | null }> {
  return rows.map(({ gateReport, ...row }) => ({ ...row, gate: readDeviceGate(gateReport) }));
}

/** What every surface shows. `null` where this box has never reported a gate. */
export type DeviceGate = GateCondition & { receivedAt: string };

export function readDeviceGate(stored: unknown): DeviceGate | null {
  if (stored === null || typeof stored !== 'object') return null;
  const { degraded, receivedAt } = stored as { degraded?: unknown; receivedAt?: unknown };
  // Half a condition is worse than none: a count with no verdict behind it.
  const parsed = conditionSchema.safeParse(degraded);
  if (!parsed.success) return null;
  return { ...parsed.data, receivedAt: typeof receivedAt === 'string' ? receivedAt : '' };
}
