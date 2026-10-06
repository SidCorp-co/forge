/**
 * A6, a box whose declaration gate is failing open. The box decides the verdict
 * (`daemon/degraded.rs`, ISS-1192) and sends it on every heartbeat into
 * `devices.gate_report`. This alert makes that verdict reach a person through the
 * Tier 1 push path, rather than sitting in `forge-runner status` until somebody
 * thinks to run it (ISS-1324).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type DeviceGate, readDeviceGate } from '../devices/gate-report.js';
import type { AdminAlert } from './types.js';

/**
 * Past this, a stored report is no longer the box's present condition. A box
 * that stopped heartbeating leaves its last report behind, and alerting on that
 * report would page someone about a gate that may already be deciding. The web
 * banner uses the same bound (`features/runners/types.ts:REPORT_FRESH_FOR_MS`).
 */
export const GATE_REPORT_FRESH_MS = 10 * 60_000;

export const GATE_ALERT_ENTITY_LIMIT = 20;

export interface GateAlertRow {
  id: string;
  name: string;
  disabledAt: Date | string | null;
  gateReport: unknown;
}

interface FailingBox {
  id: string;
  name: string;
  gate: DeviceGate;
}

function span(ms: number | null): string {
  if (ms === null) return 'an unstated span';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The count as the box can vouch for it: a floor where its file may have been trimmed. */
function countOf(gate: DeviceGate): string {
  return gate.trimmed ? `at least ${gate.count}` : `${gate.count}`;
}

function rateOf(gate: DeviceGate): string {
  return gate.perDay === null
    ? `over ${span(gate.windowMs)}`
    : `${Math.round(gate.perDay)}/day over ${span(gate.windowMs)}`;
}

function failingOpen(row: GateAlertRow, nowMs: number): FailingBox | null {
  if (row.disabledAt !== null) return null;
  const gate = readDeviceGate(row.gateReport);
  if (gate === null || gate.verdict !== 'failing_open') return null;
  const heard = Date.parse(gate.receivedAt);
  if (!Number.isFinite(heard) || nowMs - heard > GATE_REPORT_FRESH_MS) return null;
  return { id: row.id, name: row.name, gate };
}

/** The alert from rows already read, so its rule is testable without a database. */
export function gateAlert(rows: readonly GateAlertRow[], now: Date): AdminAlert {
  const nowMs = now.getTime();
  const failing = rows
    .map((r) => failingOpen(r, nowMs))
    .filter((b): b is FailingBox => b !== null)
    .sort((a, b) => b.gate.count - a.gate.count || a.name.localeCompare(b.name));
  const count = failing.length;
  const firsts = failing
    .map((b) => b.gate.firstAt)
    .filter((t): t is number => t !== null && Number.isFinite(t));
  const only = failing[0];
  return {
    id: 'A6',
    key: 'gate_failing_open',
    status: count > 0 ? 'warn' : 'ok',
    count,
    detail:
      count === 0
        ? 'No box is admitting dispatches its gate could not decide'
        : count === 1 && only
          ? `${only.name}: ${countOf(only.gate)} dispatch(es) admitted without the gate deciding, ${rateOf(only.gate)}`
          : `${count} boxes admitting dispatches their gate could not decide`,
    since: firsts.length > 0 ? new Date(Math.min(...firsts)).toISOString() : null,
    entities: failing.slice(0, GATE_ALERT_ENTITY_LIMIT).map((b) => ({
      ref: b.id,
      kind: 'device',
      label: `${b.name} · ${countOf(b.gate)} undecided, ${rateOf(b.gate)}`,
    })),
  };
}

type GateRow = {
  id: string;
  name: string;
  disabled_at: Date | string | null;
  gate_report: unknown;
};

/** A6, read from every box whose stored report says it is failing open. */
export async function alertGateFailingOpen(now: Date): Promise<AdminAlert> {
  const rows = await db.execute<GateRow>(sql`
    SELECT d.id, d.name, d.disabled_at, d.gate_report
    FROM devices d
    WHERE d.gate_report -> 'degraded' ->> 'verdict' = 'failing_open'
  `);
  return gateAlert(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      disabledAt: r.disabled_at,
      gateReport: r.gate_report,
    })),
    now,
  );
}
