/**
 * What a box says about its own declaration gate. The verdict stays the box's:
 * `daemon/degraded.rs` holds the one definition of a sustained rate (ISS-1192).
 */

import type { MasterDialogsAnswered } from '@forge/contracts/master-standing';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { utf16String } from '../lib/utf16-string.js';

const gateVerdicts = ['clear', 'marked', 'failing_open'] as const;

/**
 * The producer's bounds in the producer's unit: `daemon/degraded.rs` clips in
 * UTF-16 code units, and `utf16String` counts the same unit. Narrower than the box
 * emits refuses the whole report, and the box with most to say goes quiet. Both
 * numbers live in `gate-report.fixture.json` and each side asserts them (ISS-1192).
 */
export const WIRE_UNITS = 420;
export const WIRE_REASONS = 24;

const wire = () => utf16String(WIRE_UNITS);

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

/** The most projects one report names; the box's matching ceiling is
 *  `runner_proto::dialogs::WIRE_PROJECTS`. */
export const WIRE_DIALOG_PROJECTS = 32;

/** One project's permission dialogs the box's hook answered (`runner_core::dialog_answer`). */
const dialogsAnsweredSchema = z
  .object({
    projectId: wire().nullable(),
    count: z.number().int().nonnegative().max(1_000_000),
    countIsFloor: z.boolean(),
    firstAt: z.number().int().nullable(),
    lastAt: z.number().int().nullable(),
    last: wire().nullable(),
    lastAgent: wire().nullable(),
  })
  .strict();

const gateReportSchema = z
  .object({
    degraded: conditionSchema,
    dialogs: z.array(dialogsAnsweredSchema).max(WIRE_DIALOG_PROJECTS).optional(),
  })
  .strict();

export const gateConditionSchema = conditionSchema;

export type GateReport = z.infer<typeof gateReportSchema>;
export type GateCondition = z.infer<typeof conditionSchema>;

/** The stored column: what the box sent, and when core heard it. */
type StoredGateReport = GateReport & { receivedAt: string };

export function storedGateReport(report: GateReport, now: Date): StoredGateReport {
  return { ...report, receivedAt: now.toISOString() };
}

function readHeartbeatGate(gate: unknown): {
  report?: GateReport;
  refused?: string;
} {
  if (gate === undefined) return {};
  const parsed = gateReportSchema.safeParse(gate);
  if (parsed.success) return { report: parsed.data };
  const first = parsed.error.issues[0];
  const at = first?.path.length ? `gate.${first.path.join('.')}` : 'gate';
  return { refused: `${at}: ${first?.message ?? 'not a gate condition core can read'}` };
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

function readDeviceGate(stored: unknown): DeviceGate | null {
  if (stored === null || typeof stored !== 'object') return null;
  const { degraded, receivedAt } = stored as { degraded?: unknown; receivedAt?: unknown };
  // Half a condition is worse than none: a count with no verdict behind it.
  const parsed = conditionSchema.safeParse(degraded);
  if (!parsed.success) return null;
  return { ...parsed.data, receivedAt: typeof receivedAt === 'string' ? receivedAt : '' };
}

const isoOf = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * What the box's hook answered for `projectId`, off the stored gate report. `null` where the box
 * reported none for it; a stored entry core cannot read is `null` too, and logged, since the report
 * was validated on the way in.
 */
export function readDialogsAnswered(
  stored: unknown,
  projectId: string,
): MasterDialogsAnswered | null {
  if (stored === null || typeof stored !== 'object') return null;
  const dialogs = (stored as { dialogs?: unknown }).dialogs;
  if (dialogs === undefined) return null;
  const parsed = z.array(dialogsAnsweredSchema).safeParse(dialogs);
  if (!parsed.success) {
    logger.warn(
      { projectId, reason: parsed.error.issues[0]?.message },
      'gate report: stored answered dialogs core cannot read',
    );
    return null;
  }
  const mine = parsed.data.find((d) => d.projectId === projectId);
  if (!mine) return null;
  return {
    count: mine.count,
    countIsFloor: mine.countIsFloor,
    firstAt: isoOf(mine.firstAt),
    lastAt: isoOf(mine.lastAt),
    last: mine.last,
    lastAgent: mine.lastAgent,
  };
}
