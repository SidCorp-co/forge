import type { PipelineHealth } from '@forge/contracts/pipeline-control';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { DEFAULT_RECOVERY_STATS } from './pipeline-control-types.js';
import { pushSession } from './push.js';
import { sessionAudience } from './session-access.js';

export async function publishSessionRecoveryChanged(
  projectId: string,
  sessionId: string,
): Promise<void> {
  const [row] = await db
    .select({
      pipelineHealth: agentSessions.pipelineHealth,
      projectId: agentSessions.projectId,
      userId: agentSessions.userId,
      kind: agentSessions.kind,
      metadata: agentSessions.metadata,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!row) return;

  const health = row.pipelineHealth as PipelineHealth | null;
  const recoveryStats = health?.recoveryStats ?? DEFAULT_RECOVERY_STATS;

  const audience = await sessionAudience(row);
  await pushSession({
    projectId: audience.projectWide ? projectId : null,
    deviceId: null,
    userIds: audience.userIds,
    event: 'session.recoveryChanged',
    data: { sessionId, recoveryStats },
  });
}
