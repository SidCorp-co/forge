// What the runners kernel needs from the modules above it, handed in by the process entry at boot
// (ADR 0008: a kernel imports only kernel and platform modules). Read only inside a call.

interface RunnersPorts {
  /** The operator's thresholds; the reaper reads how long a runner may stay offline. */
  readThresholds(): Promise<{ ghostRunnerOfflineDays: number }>;
}

let provided: RunnersPorts | null = null;

export function provideRunnersPorts(ports: RunnersPorts): void {
  provided = ports;
}

export function runnersPorts(): RunnersPorts {
  if (!provided) {
    throw new Error(
      'runners: no ports were provided, so a runner cannot read the thresholds; the process entry calls provideRunnersPorts before it serves',
    );
  }
  return provided;
}
