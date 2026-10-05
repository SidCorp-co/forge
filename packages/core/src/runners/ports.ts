import type { Column, SQL } from 'drizzle-orm';
import { portSlot } from '../lib/port-slot.js';

// What the runners kernel needs from the modules above it, handed in by the process entry at boot
// (ADR 0008: a kernel imports only kernel and platform modules). Read only inside a call.

interface RunnersPorts {
  /** The live jobs occupying each runner, from the job ledger. */
  countInFlightByRunner(runnerIds: string[]): Promise<Map<string, number>>;
  /** The live resident master a device holds for a project, as a subquery over the outer row. */
  residentMasterSql(
    deviceIdColumn: Column,
    projectIdColumn: Column,
  ): SQL<{ sessionId: string; name: string; lastHeartbeatAt: string | null } | null>;
  /** A runner's stored pool read as every surface shows it; null when none is readable. */
  readRunnerPoolRead(stored: unknown): object | null;
  /** Whether any socket reads this box's room right now. */
  boxIsListening(deviceId: string): boolean;
  /** Hand a frame to the box's open sockets now, answering how many took it. */
  sendToBoxNow(deviceId: string, envelope: { event: string; data: unknown }): number;
}

const slot = portSlot<RunnersPorts>('runners', 'provideRunnersPorts');
export const provideRunnersPorts = slot.provide;
export const runnersPorts = slot.get;
