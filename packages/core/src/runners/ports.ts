// What the runners kernel needs from the modules above it, handed in by the process entry at boot
// (ADR 0008: a kernel imports only kernel and platform modules). Read only inside a call.

export interface RunnersPorts {
  /** The runner build this deployment publishes, or null when it publishes none. */
  publishedRunnerBuild(): Promise<{ version: string; commit: string | null } | null>;
  /** The runner commit on main, as last read; null before the first read. */
  mainRunnerHead(): string | null;
  /** The operator's thresholds; the reaper reads how long a runner may stay offline. */
  readThresholds(): Promise<{ ghostRunnerOfflineDays: number }>;
  /** The live jobs occupying each runner, from the job ledger. */
  countInFlightByRunner(runnerIds: string[]): Promise<Map<string, number>>;
}

let provided: RunnersPorts | null = null;

export function provideRunnersPorts(ports: RunnersPorts): void {
  provided = ports;
}

export function runnersPorts(): RunnersPorts {
  if (!provided) {
    throw new Error(
      'runners: no ports were provided, so a runner cannot read the published build or the thresholds; the process entry calls provideRunnersPorts before it serves',
    );
  }
  return provided;
}
