import { TOKEN_EXPLICIT_PERMISSIONS } from '@forge/contracts/permissions';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { grantNaming, regrantLiveTokens } from '../credentials/pat.js';
import { db, type Tx } from '../db/client.js';
import { projectMembers, users } from '../db/schema.js';
import { lockXact } from '../lib/advisory-lock.js';

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
  outer: Tx = db,
): Promise<T> {
  return outer.transaction(async (tx) => {
    await lockXact(tx, 'agentFence', agentUserId);
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
    throw new HTTPException(400, {
      message: `agent ${agentUserId} is a member of no project, so a credential minted for it would be fenced to nothing; give it a project membership first`,
      cause: { code: 'AGENT_HAS_NO_PROJECT' },
    });
  }
  return fenceFor(rows.map((r) => r.projectId));
}

/**
 * The token-explicit permissions (every approval among them) the agent's memberships grant. A
 * credential core mints for an agent names them, because a token reaches one only by name: the
 * org admin's grant on the membership is what decides, and the credential carries it.
 */
async function agentExplicitGrant(agentUserId: string, tx: Tx = db): Promise<string[]> {
  const rows = await tx
    .select({ grants: projectMembers.grants })
    .from(projectMembers)
    .where(eq(projectMembers.userId, agentUserId));
  const explicit = TOKEN_EXPLICIT_PERMISSIONS as readonly string[];
  return [...new Set(rows.flatMap((r) => r.grants).filter((g) => explicit.includes(g)))];
}

async function isAgent(tx: Tx, userId: string): Promise<boolean> {
  const [holder] = await tx
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return holder?.kind === 'agent';
}

/**
 * The grant of a credential core mints for its holder: every route, and, for an agent, its explicit
 * permissions by name. A person's is every route alone.
 */
export async function agentCredentialGrant(holderUserId: string, tx: Tx = db): Promise<string[]> {
  const explicit = (await isAgent(tx, holderUserId))
    ? await agentExplicitGrant(holderUserId, tx)
    : [];
  return grantNaming(null, explicit);
}

/**
 * Bring every live credential of an agent in line with its memberships' grants, after one changed.
 * A person's tokens name what that person chose at mint and are left as they are.
 */
export async function regrantAgentCredentials(tx: Tx, userId: string): Promise<number> {
  if (!(await isAgent(tx, userId))) return 0;
  return regrantLiveTokens(tx, userId, await agentExplicitGrant(userId, tx));
}
