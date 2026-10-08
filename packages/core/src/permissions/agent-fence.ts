import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { regrantLiveTokens } from '../credentials/pat.js';
import {
  PAT_FULL_NARROWING_PERMISSIONS,
  PAT_PERMISSION_ALL,
  type StatedPatGrant,
} from '../credentials/pat-permissions.js';
import { db, type Tx } from '../db/client.js';
import { projectMembers } from '../db/schema.js';
import { lockXact } from '../lib/advisory-lock.js';
import { permissionsPort } from './ports.js';

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
 * The narrowing names (`PAT_FULL_NARROWING_PERMISSIONS`) the agent's memberships grant. A credential
 * core mints for an agent names them beside `*`, because naming one is what makes it an observer's
 * credential (`TOKEN_GRANT_EXCLUSIONS`). Nothing else is named: a full grant already holds every
 * permission the agent's role and membership grants hold, approvals included (REQ-27 BC-4).
 */
async function agentNarrowingGrant(agentUserId: string, tx: Tx = db): Promise<string[]> {
  const rows = await tx
    .select({ grants: projectMembers.grants })
    .from(projectMembers)
    .where(eq(projectMembers.userId, agentUserId));
  return [
    ...new Set(
      rows.flatMap((r) => r.grants).filter((g) => PAT_FULL_NARROWING_PERMISSIONS.includes(g)),
    ),
  ];
}

async function isAgent(tx: Tx, userId: string): Promise<boolean> {
  return (await permissionsPort('agentAccountsAmong')([userId], tx)).has(userId);
}

/**
 * The grant of a credential core mints for its holder: full, and, for an agent, narrowed by the
 * observer key its memberships grant. A person's is full alone.
 */
export async function agentCredentialGrant(
  holderUserId: string,
  tx: Tx = db,
): Promise<StatedPatGrant> {
  const narrowing = (await isAgent(tx, holderUserId))
    ? await agentNarrowingGrant(holderUserId, tx)
    : [];
  return [PAT_PERMISSION_ALL, ...narrowing];
}

/**
 * Bring every live credential of an agent in line with its memberships' grants, after one changed:
 * each names the narrowing permissions they grant and no other token-explicit one. A person's
 * tokens name what that person chose at mint and are left as they are.
 */
export async function regrantAgentCredentials(tx: Tx, userId: string): Promise<number> {
  if (!(await isAgent(tx, userId))) return 0;
  return regrantLiveTokens(tx, userId, await agentNarrowingGrant(userId, tx));
}
