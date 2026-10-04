// What a release needs from modules it may not import at load: the contract waits the providers'
// production does not serve yet (ecosystem sits after release in the context order), and the
// pipeline's writes on a release run. The composition root fills them at boot (`provideProjectOrg`
// is the pattern).

import type { LiveShortfall } from '@forge/contracts/contract-waits';
import type { Tx } from '../db/client.js';
import type { RunMetadataWrite } from '../pipeline/index.js';

interface ReleaseBatchPorts {
  contractProviderShortfalls(issueIds: readonly string[]): Promise<LiveShortfall[]>;
  /** The pipeline's writes on a release run's own row (`pipeline/run-records.ts`). Reached through
   *  the port while the pipeline's sweeper still imports this module at load, so a static import
   *  of the pipeline face would close a runtime cycle. */
  writeRunMetadata(runId: string, write: RunMetadataWrite, executor?: Tx): Promise<boolean>;
  stampReleaseVersion(runId: string, version: string, executor?: Tx): Promise<boolean>;
  stampReleaseShipped(runId: string, executor?: Tx): Promise<void>;
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
