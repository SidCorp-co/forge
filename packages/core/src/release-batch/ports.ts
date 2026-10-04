// What a release needs from the ecosystem context, which sits after release in the context order:
// the contract waits the providers' production does not serve yet. The composition root fills it at
// boot (`provideProjectOrg` is the pattern).

import type { LiveShortfall } from '@forge/contracts/contract-waits';

export interface ReleaseBatchPorts {
  contractProviderShortfalls(issueIds: readonly string[]): Promise<LiveShortfall[]>;
}

let ports: ReleaseBatchPorts | null = null;

export function provideReleaseBatchPorts(given: ReleaseBatchPorts): void {
  ports = given;
}

export function releaseBatchPorts(): ReleaseBatchPorts {
  if (!ports) {
    throw new Error(
      'release-batch: no ports were provided; the process entry calls provideReleaseBatchPorts before it serves',
    );
  }
  return ports;
}
