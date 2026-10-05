import type { PipelineHealth } from '@forge/contracts/pipeline-control';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { DEFAULT_RECOVERY_STATS } from './pipeline-control-types.js';
import { pushSession } from './push.js';

export async function publishSessionRecoveryChanged(
  projectId: string,
  sessionId: string,
): Promise<void> {
  const [row] = await db
    .select({ pipelineHealth: agentSessions.pipelineHealth })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!row) return;

  const health = row.pipelineHealth as PipelineHealth | null;
  const recoveryStats = health?.recoveryStats ?? DEFAULT_RECOVERY_STATS;

  await pushSession({
    projectId,
    deviceId: null,
    event: 'session.recoveryChanged',
    data: { sessionId, recoveryStats },
  });
}
