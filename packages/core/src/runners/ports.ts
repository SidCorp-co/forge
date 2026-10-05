import { portSlot } from '../lib/port-slot.js';

// What the runners kernel needs from the modules above it, handed in by the process entry at boot
// (ADR 0008: a kernel imports only kernel and platform modules). Read only inside a call.

interface RunnersPorts {
  /** The live jobs occupying each runner, from the job ledger. */
  countInFlightByRunner(runnerIds: string[]): Promise<Map<string, number>>;
}

const slot = portSlot<RunnersPorts>('runners', 'provideRunnersPorts');
export const provideRunnersPorts = slot.provide;
export const runnersPorts = slot.get;
