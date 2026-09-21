import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { compareRunnerBuild } from '../devices/build-state.js';
import { mainRunnerHead } from '../install/main-runner-head.js';
import { getPublishedRunnerBuild } from '../install/routes.js';
import type { HealthResult, Runner, RunnerAdapter } from './types.js';

/**
 * Undefined where the runner is bound to no device, or the row has gone: the
 * comparison has no subject, which the health read reports as unread, not as passing.
 */
async function runnerBuildComparison(deviceId: string | null) {
  if (!deviceId) return undefined;
  const [device] = await db
    .select({ agentVersion: devices.agentVersion, agentCommit: devices.agentCommit })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) return undefined;
  return compareRunnerBuild(
    { version: device.agentVersion, commit: device.agentCommit },
    { published: await getPublishedRunnerBuild(), mainRunnerHead: mainRunnerHead() },
  );
}

/** One call, so the route need not know a health verdict has two halves. */
export async function runnerHealthWithBuild(
  adapter: RunnerAdapter,
  runner: Runner,
  deviceId: string | null,
): Promise<HealthResult> {
  return adapter.health({ runner, build: await runnerBuildComparison(deviceId) });
}
