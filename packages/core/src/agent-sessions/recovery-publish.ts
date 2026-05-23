/**
 * Direct WS publisher for `session.recoveryChanged` (ISS-197).
 *
 * Mirrors `publishPipelineHealthChanged` in `issues/pipeline-health.ts`:
 * loads the freshly-written recoveryStats and emits a derived snapshot to
 * the project room. The lazy import of `ws/server.js` keeps unit tests of
 * the retry engine from pulling pg-boss + WS server transitively.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { projectRoom } from '../ws/rooms.js';
import type { PipelineHealth } from './pipeline-control-types.js';
import { DEFAULT_RECOVERY_STATS } from './pipeline-control-types.js';

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

  const { roomManager } = await import('../ws/server.js');
  roomManager.publish(projectRoom(projectId), {
    event: 'session.recoveryChanged',
    data: { sessionId, recoveryStats },
  });
}
