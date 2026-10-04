// What the PM reads need from the contexts below work: the job ledger to read runner load from.
// The composition root provides it at boot.

export interface PmPorts {
  countInFlightByRunner: (runnerIds: string[]) => Promise<Map<string, number>>;
}

let provided: PmPorts | null = null;

export function providePmPorts(given: PmPorts): void {
  provided = given;
}

function pmPorts(): PmPorts {
  if (!provided) {
    throw new Error(
      'pm: no ports were provided; the process entry calls providePmPorts before it serves',
    );
  }
  return provided;
}

export const countInFlightByRunner: PmPorts['countInFlightByRunner'] = (runnerIds) =>
  pmPorts().countInFlightByRunner(runnerIds);
