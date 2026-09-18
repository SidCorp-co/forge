/**
 * The fence an agent's credential is minted behind, and the lock that makes it true.
 *
 * Split out of `agent-accounts.ts` so the two axes stay separable: that module owns
 * the ACCOUNT — who exists, what it is called, what it reaches — and this one owns
 * the narrow question of which projects a token minted for it may open, which three
 * writers ask and none of them may answer for itself.
 */

import { eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { projectMembers } from '../db/schema.js';

export const badRequest = (message: string, code: string) =>
  new HTTPException(400, { message, cause: { code } });

/**
 * The fence a credential for this agent is minted behind.
 *
 * Two shapes, and the single-project one is not a special case to be tidied away:
 * `bound_project_id` is BOTH the auth fence and the project a caller that names
 * none resolves to, so an agent on one project keeps the exact reach and the exact
 * default it had before this existed.
 */
export interface AgentCredentialFence {
  boundProjectId: string | null;
  projectIds: string[] | null;
}

/**
 * The fence for a set of projects, and the ONE place either shape is chosen.
 *
 * Three writers mint for an agent — this module's create and credential routes and
 * `devices/credential.ts` when a box pairs as one — and a fence decided separately
 * in each is three chances for one of them to mint the account-wide token that
 * `boundProjectId` exists to prevent.
 */
// cm:guard one project keeps `boundProjectId` and a NULL `projectIds`, and that is not the array shape written shorter. `bound_project_id` is also the project a caller that names none resolves to (`mcp/tools/lib.ts:resolveEffectiveProjectId`), so collapsing the two shapes into one would silently take the default away from every agent that has one — the existing single-project agent whose behaviour ISS-1093 rule 2 holds fixed. Several projects cannot have a default and must not pretend to one: the caller names the project or is refused.
// cm:guard `projectIds: []` is never this function's answer. An empty array fences a token to NO project, which `devices/credential.ts` uses deliberately for a person's box; reached from here it would be an agent credential that opens nothing, so a set with no members is refused by its callers before they get here.
export function fenceFor(projectIds: string[]): AgentCredentialFence {
  const ids = [...new Set(projectIds)];
  if (ids.length === 1) return { boundProjectId: ids[0] as string, projectIds: null };
  return { boundProjectId: null, projectIds: ids };
}

/**
 * Serialize everything that decides a fence for ONE agent, against everything
 * that rewrites its fences.
 *
 * Reading the memberships and inserting the token are two statements, and
 * `setAgentProjects` re-fences only the tokens that EXIST when it runs. Between
 * those two statements a project set can be widened and committed, and the token
 * then lands carrying the old, narrower fence with no further update coming —
 * which on the box is the "I added the project and it still 404s" shape this
 * whole re-fence exists to remove. A transaction-scoped advisory lock keyed on
 * the agent makes either order correct: mint first and the re-fence catches the
 * new token, re-fence first and the mint reads the new set.
 */
// cm:guard the key is the AGENT and not a global one, so two admins working on two agents never wait on each other; and it is `_xact_`, so it is released by commit or rollback and no failure path can leak it. Every reader of `agentCredentialFence` that goes on to WRITE a token must be inside this, which is why the two mint paths call it and the plain read does not.
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
