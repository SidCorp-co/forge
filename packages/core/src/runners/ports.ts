// What the runners kernel needs from the modules above it, handed in by the process entry at boot
// (ADR 0008: a kernel imports only kernel and platform modules). Read only inside a call.

interface RunnersPorts {
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
      'runners: no ports were provided, so a runner cannot count its in-flight jobs; the process entry calls provideRunnersPorts before it serves',
    );
  }
  return provided;
}
