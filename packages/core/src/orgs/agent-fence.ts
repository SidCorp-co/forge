import { eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { projectMembers } from '../db/schema.js';

export const badRequest = (message: string, code: string) =>
  new HTTPException(400, { message, cause: { code } });

export interface AgentCredentialFence {
  boundProjectId: string | null;
  projectIds: string[] | null;
}

export function fenceFor(projectIds: string[]): AgentCredentialFence {
  const ids = [...new Set(projectIds)];
  if (ids.length === 1) return { boundProjectId: ids[0] as string, projectIds: null };
  return { boundProjectId: null, projectIds: ids };
}

export async function withAgentFenceLock<T>(
  agentUserId: string,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${agentUserId}, 0))`);
    return run(tx);
  });
}

/**
 * The fence a credential for this agent must carry right now, read from its
 * memberships. Refuses an agent that is a member of nothing.
 */
export async function agentCredentialFence(
  agentUserId: string,
  tx: Tx = db,
): Promise<AgentCredentialFence> {
  const rows = await tx
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, agentUserId));
  if (rows.length === 0) {
    throw badRequest(
      `agent ${agentUserId} is a member of no project, so a credential minted for it would be fenced to nothing; give it a project membership first`,
      'AGENT_HAS_NO_PROJECT',
    );
  }
  return fenceFor(rows.map((r) => r.projectId));
}
