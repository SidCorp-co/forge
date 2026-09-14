/**
 * Agent Access Tokens — the writer for "this org has a named agent" (ISS-932).
 *
 * Everything an agent gets, it gets from machinery a person already used: a
 * `users` row, an `organization_members` row, a `project_members` row and a
 * PAT from `mintPat`. There is no agent-shaped authorization path, which is
 * the point — `effectiveProjectRole` and the membership reads behind it never
 * learn that agents exist.
 */

import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { isAgentHandle, synthesizeAgentEmail } from '../auth/agent-account.js';
import { mintPat } from '../auth/pat.js';
import { patIsLive } from '../auth/pat-live.js';
import { db } from '../db/client.js';
import {
  organizationMembers,
  type ProjectMemberRole,
  personalAccessTokens,
  projectMembers,
  projects,
  users,
} from '../db/schema.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';

export interface CreateAgentAccountInput {
  orgId: string;
  /** The one project this agent works on — option A, one AAT one project. */
  projectId: string;
  /** Lowercase handle; becomes the display name and the local part of its address. */
  handle: string;
  projectRole?: ProjectMemberRole;
}

export interface AgentAccount {
  userId: string;
  handle: string;
  /** The label a person reads, or null where nobody has typed one. */
  displayName: string | null;
  email: string;
  projectId: string;
  projectRole: ProjectMemberRole;
  createdAt: Date;
  /** Credentials this account holds that {@link patIsLive} would still accept. */
  activeTokens: number;
  /** Whether this account can act at all, which is the only thing a reader wants. */
  canAct: boolean;
}

const badRequest = (message: string, code: string) =>
  new HTTPException(400, { message, cause: { code } });

/**
 * Create the agent and mint its one token. The plaintext is returned exactly
 * once, the same contract `POST /api/pat` has.
 */
// cm:guard one transaction, and the token is minted INSIDE it. An agent row that exists without its memberships is a principal with no authority and no way to be given any through this route (the handle is taken), while memberships without a row are an FK error; both are states an operator has to clean up by hand. `mintPat` writes to `personal_access_tokens` on the ambient `db`, so it is called after the tx commits and its failure leaves a tokenless agent the revoke route can remove — the one partial state that is recoverable through the API.
export async function createAgentAccount(
  input: CreateAgentAccountInput,
): Promise<{ agent: AgentAccount; plaintext: string }> {
  if (!isAgentHandle(input.handle)) {
    throw badRequest(
      'handle must be 3-40 lowercase letters, digits or hyphens, starting and ending alphanumeric',
      'INVALID_AGENT_HANDLE',
    );
  }

  const [project] = await db
    .select({ id: projects.id, orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project || project.orgId !== input.orgId) {
    throw new HTTPException(404, {
      message: 'project not found in this organization',
      cause: { code: 'NOT_FOUND' },
    });
  }

  const projectRole: ProjectMemberRole = input.projectRole ?? 'member';
  const email = synthesizeAgentEmail(input.handle);

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        email,
        kind: 'agent',
        passwordHash: null,
        // cm:guard stamped verified at creation, because `assertEmailVerified` gates the whole PAT-authenticated REST surface and an agent has no mailbox to verify through. It is safe only because `signUserToken` refuses `kind:'agent'` outright — the verified stamp buys REST access, never a session.
        emailVerifiedAt: new Date(),
        displayName: input.handle,
      })
      .returning({ id: users.id, createdAt: users.createdAt });
    if (!row) throw new Error('createAgentAccount: user insert returned no row');

    // cm:guard `member`, never `admin`. Org admin is what MANAGES agents (mint, revoke); an agent holding it could create further agents and grant them anything, which is the credential-mints-credential hole `/api/pat`'s absence from `PAT_ALLOWED_PREFIXES` closes on the other side.
    // cm:guard the handle goes in with the membership, in one statement, because `(org_id, handle)` is the index that refuses a second `@forge-dev` in this org — a membership inserted first and named afterwards is a window in which that index has nothing to refuse (ISS-1003 criterion 12).
    await tx.insert(organizationMembers).values({
      orgId: input.orgId,
      userId: row.id,
      role: 'member',
      handle: input.handle,
    });
    await tx.insert(projectMembers).values({
      userId: row.id,
      projectId: input.projectId,
      role: projectRole,
    });
    return row;
  });

  const minted = await mintPat({
    userId: created.id,
    name: `agent:${input.handle}`,
    scopes: ['read', 'write'],
    boundProjectId: input.projectId,
  });

  return {
    agent: {
      userId: created.id,
      handle: input.handle,
      displayName: input.handle,
      email,
      projectId: input.projectId,
      projectRole,
      createdAt: created.createdAt,
      activeTokens: 1,
      canAct: true,
    },
    plaintext: minted.plaintext,
  };
}

/**
 * Every agent account in this org, and whether each can act.
 *
 * One query. The per-agent token count used to be a second query inside the
 * loop, so listing an org of forty agents cost forty-one round trips.
 */
// cm:guard `canAct` is the live-credential predicate and NOT `revoked_at IS NULL`: an agent holding one unrevoked but EXPIRED token counted as able to act here while `verifyPat` turned that same token away, so the console said yes about an account the door said no about. `patIsLive` is the single spelling both sides now read (ISS-1003 criteria 2, 7).
export async function listAgentAccounts(orgId: string): Promise<AgentAccount[]> {
  const live = db
    .select({ userId: personalAccessTokens.userId, n: count().as('n') })
    .from(personalAccessTokens)
    .where(patIsLive())
    .groupBy(personalAccessTokens.userId)
    .as('live');

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      handle: organizationMembers.handle,
      displayName: users.displayName,
      createdAt: users.createdAt,
      projectId: projectMembers.projectId,
      projectRole: projectMembers.role,
      activeTokens: live.n,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(projectMembers, eq(projectMembers.userId, users.id))
    .leftJoin(live, eq(live.userId, users.id))
    .where(and(eq(organizationMembers.orgId, orgId), eq(users.kind, 'agent')))
    .orderBy(desc(users.createdAt));

  return rows.map((row) => {
    const activeTokens = row.activeTokens ?? 0;
    return {
      userId: row.userId,
      handle: row.handle ?? '',
      displayName: row.displayName,
      email: row.email,
      projectId: row.projectId ?? '',
      projectRole: row.projectRole ?? 'member',
      createdAt: row.createdAt,
      activeTokens,
      // cm:guard BOTH halves, because a live credential is only half of being able to act: the token is fenced to one project and `effectiveProjectRole` is what answers on the other side, so an agent whose project membership was removed after its token was minted holds a credential that opens nothing. Reported as the credential fact alone, `reachOf`'s "belongs to no project" branch is unreachable and the console tells an admin to mint a second credential that will not help either (ISS-1003 criteria 2, 6, 7).
      canAct: activeTokens > 0 && row.projectId != null,
    };
  });
}

/**
 * The agent of this org behind `agentUserId`, or null where there is none.
 *
 * Every credential route asks through here, so "is this id an agent of the org
 * the caller is admin of" is one question with one answer rather than three.
 */
async function loadOrgAgent(
  orgId: string,
  agentUserId: string,
): Promise<{ id: string; handle: string | null } | null> {
  const [row] = await db
    .select({ id: users.id, handle: organizationMembers.handle })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, agentUserId),
        eq(users.kind, 'agent'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Give a credential to an agent that already exists.
 *
 * The population this exists for is the handles `conversations/handles.ts`
 * mints: an agent with a name in a room and no token, which
 * {@link createAgentAccount} cannot reach because it only ever mints beside a
 * creation.
 */
// cm:guard the token is bound to the project the agent is a member of, never unbound, because `createAgentAccount` binds the one it mints and an agent credentialed through this route would otherwise reach every project its owner does. An agent with no project membership is refused here rather than given an unbound token: a credential whose fence resolves to nothing is the account-scoped token `boundProjectId` exists to prevent (ISS-497).
export async function mintAgentCredential(
  orgId: string,
  agentUserId: string,
): Promise<{ plaintext: string; boundProjectId: string } | null> {
  const agent = await loadOrgAgent(orgId, agentUserId);
  if (!agent) return null;

  const [membership] = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, agentUserId))
    .limit(1);
  if (!membership) {
    throw badRequest(
      `agent ${agentUserId} is a member of no project, so a credential minted for it would be fenced to nothing; give it a project membership first`,
      'AGENT_HAS_NO_PROJECT',
    );
  }

  const minted = await mintDistinctlyNamed(
    agent.id,
    `agent:${agent.handle ?? agent.id}`,
    membership.projectId,
  );
  return { plaintext: minted, boundProjectId: membership.projectId };
}

/**
 * Mint under a name `pat_user_name_uniq` will accept, escalating rather than looping.
 *
 * `personal_access_tokens` is unique on `(user_id, name)` and a REVOKED row keeps
 * its name, so the obvious `agent:<handle>` collides the second time an admin
 * credentials the same agent — which is the ordinary case, since taking the
 * credential away and giving a new one is what this pair of routes is for.
 */
// cm:guard three attempts and then a REFUSAL, never a loop and never a silent skip: the caller never types this name, so a collision is ours to resolve, but a retry with no bound turns a constraint nobody can satisfy into a request that never returns. The escalation is deterministic first (the timestamp, which reads well in a token list) and random only as the last step, so the common second mint gets a name a person can still recognise.
async function mintDistinctlyNamed(
  userId: string,
  base: string,
  boundProjectId: string,
): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const names = [base, `${base} ${stamp}`, `${base} ${randomBytes(4).toString('hex')}`];
  for (const name of names) {
    try {
      const minted = await mintPat({ userId, name, scopes: ['read', 'write'], boundProjectId });
      return minted.plaintext;
    } catch (err) {
      if (!isUniqueViolation(err) || uniqueViolationConstraint(err) !== 'pat_user_name_uniq') {
        throw err;
      }
    }
  }
  throw badRequest(
    `every name this route would give a credential for agent ${userId} is already taken (${names.join(', ')}); ask again and the third name is drawn fresh — revoking will not free one, because a revoked row keeps its name under pat_user_name_uniq`,
    'AGENT_CREDENTIAL_NAME_TAKEN',
  );
}

/**
 * Take every live credential away from an agent, leaving the account standing.
 *
 * Distinct from {@link revokeAgentAccount}, which also drops the memberships:
 * this is "it may not act right now", that is "it is retired".
 */
// cm:guard revoking a credential may not fail on anything conversational, and this writes to ONE table for that reason — removing authority is a security action and issue rule 4 says it always succeeds. A room that loses its only able handle stays readable and reports the handle unreachable; that is `conversations/scope.ts`'s job and never a reason to refuse here (ISS-1003 criteria 5, 18).
export async function revokeAgentCredentials(
  orgId: string,
  agentUserId: string,
): Promise<number | null> {
  if (!(await loadOrgAgent(orgId, agentUserId))) return null;
  const revoked = await db
    .update(personalAccessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(personalAccessTokens.userId, agentUserId), isNull(personalAccessTokens.revokedAt)),
    )
    .returning({ id: personalAccessTokens.id });
  return revoked.length;
}

/**
 * Retire an agent: every token revoked, every membership dropped. The `users`
 * row STAYS.
 */
// cm:guard the row is never deleted, and that is not tidiness deferred. `activity_log.actor_id`, `kernel_transitions.actor_id`, `issue_activity` and `jobs.created_by` all point at it, so deleting it either cascades away the record of what the agent did or fails on a restrict — and the whole reason an agent is a real principal is so "who made this write" keeps a true answer after the agent is gone. Authority is what is removed: no live token and no membership is no reach, which `effectiveProjectRole` already returns `null` for.
export async function revokeAgentAccount(orgId: string, agentUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, agentUserId),
        eq(users.kind, 'agent'),
      ),
    )
    .limit(1);
  if (!row) return false;

  await db.transaction(async (tx) => {
    await tx
      .update(personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(personalAccessTokens.userId, agentUserId), isNull(personalAccessTokens.revokedAt)),
      );
    await tx.delete(projectMembers).where(eq(projectMembers.userId, agentUserId));
    await tx
      .delete(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, agentUserId)),
      );
  });
  return true;
}

/**
 * Set the label an org admin reads this agent by.
 *
 * `null` clears it back to having none, which is a state the renderers already
 * have a branch for.
 */
// cm:guard this writes `users.display_name` and NEVER `organization_members.handle`: the two are a label and an address, and the whole point of splitting them is that the label may be re-typed freely while the address is a key somebody's mention resolves against. A setter that moved both would hand `@old-name` to whoever takes the name next — the thing `assistant_speaker_links` already refuses one table over (ISS-1003 criterion 8).
export async function setAgentDisplayName(
  orgId: string,
  agentUserId: string,
  displayName: string | null,
): Promise<string | null | undefined> {
  if (!(await loadOrgAgent(orgId, agentUserId))) return undefined;
  const [row] = await db
    .update(users)
    .set({ displayName })
    .where(eq(users.id, agentUserId))
    .returning({ displayName: users.displayName });
  return row?.displayName ?? null;
}
