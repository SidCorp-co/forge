/**
 * The scheduled maintenance jobs core registers at boot: the device and runner reapers, the memory
 * upkeep, and the backlog index's safety net. They share one trait, a pg-boss queue with a cron and
 * nothing to wire into the request path, so `index.ts` makes one call instead of one per job.
 */

import { registerMasterReaper } from './devices/master-reaper.js';
import { registerDevicePrune } from './devices/prune.js';
import { registerRunSessionReaper } from './devices/run-session-reaper.js';
import { registerDeviceStaleDetector } from './devices/stale-detector.js';
import { registerBacklogIndexSweeper } from './issues/backlog/index-sweeper.js';
import { registerChunkReindex } from './memory/chunk-reindex.js';
import {
  registerMemoryConsolidation,
  registerMemoryReconcileWorker,
} from './memory/consolidation.js';
import { registerMemoryDecay } from './memory/decay.js';
import { registerEmbeddingBackfill } from './memory/embedding-backfill.js';
import { registerGhostRunnerReaper } from './runners/ghost-reaper.js';
import { registerRunnerStaleDetector } from './runners/stale-detector.js';

export async function registerMaintenanceJobs(): Promise<void> {
  await registerDeviceStaleDetector();
  await registerEmbeddingBackfill();
  await registerChunkReindex();
  await registerMemoryDecay();
  await registerMemoryConsolidation();
  await registerMemoryReconcileWorker();
  await registerDevicePrune();
  await registerMasterReaper();
  await registerRunSessionReaper();
  await registerRunnerStaleDetector();
  await registerGhostRunnerReaper();
  await registerBacklogIndexSweeper();
}
