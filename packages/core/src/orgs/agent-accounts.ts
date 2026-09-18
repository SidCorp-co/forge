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
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { isAgentHandle, synthesizeAgentEmail } from '../auth/agent-account.js';
import { mintPat } from '../auth/pat.js';
import { patIsLive } from '../auth/pat-live.js';
import { existingProjectHandle, handleNameForProject } from '../conversations/handles.js';
import { db, type Tx } from '../db/client.js';
import {
  organizationMembers,
  type ProjectMemberRole,
  personalAccessTokens,
  projectMembers,
  projects,
  users,
} from '../db/schema.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';
import {
  type AgentCredentialFence,
  agentCredentialFence,
  badRequest,
  fenceFor,
  withAgentFenceLock,
} from './agent-fence.js';

export interface CreateAgentAccountInput {
  orgId: string;
  /**
   * Every project this agent works on, at least one (ISS-1093). A box serving
   * several projects holds ONE credential, so an agent that reaches only one
   * project is a box that has to borrow a person's token instead.
   */
  projectIds: string[];
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
  /** Every project this agent is a member of; empty for an agent that reaches none. */
  projects: { id: string; role: ProjectMemberRole }[];
  createdAt: Date;
  /** Credentials this account holds that {@link patIsLive} would still accept. */
  activeTokens: number;
  /** Whether this account can act at all, which is the only thing a reader wants. */
  canAct: boolean;
}

/**
 * Create the agent and mint its one token. The plaintext is returned exactly
 * once, the same contract `POST /api/pat` has.
 */
// cm:guard one transaction, and the token is minted INSIDE it. An agent row that exists without its memberships is a principal with no authority and no way to be given any through this route (the handle is taken), while memberships without a row are an FK error; both are states an operator has to clean up by hand. `mintPat` writes to `personal_access_tokens` on the ambient `db`, so it is called after the tx commits and its failure leaves a tokenless agent the revoke route can remove — the one partial state that is recoverable through the API.
/**
 * Turn `(org_id, handle)`'s refusal into one a caller can act on.
 */
async function mapHandleCollision<T>(
  input: { orgId: string; handle: string },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (
      isUniqueViolation(err) &&
      uniqueViolationConstraint(err) === 'organization_members_org_handle_uniq'
    ) {
      throw new HTTPException(409, {
        message: `@${input.handle} is already an agent of organization ${input.orgId}; a handle is the address typed after @ and one org holds one of each, so give this agent a different handle or rename the one that has it`,
        cause: { code: 'AGENT_HANDLE_TAKEN' },
      });
    }
    throw err;
  }
}

export async function createAgentAccount(
  input: CreateAgentAccountInput,
): Promise<{ agent: AgentAccount; plaintext: string }> {
  if (!isAgentHandle(input.handle)) {
    throw badRequest(
      'handle must be 3-40 lowercase letters, digits or hyphens, starting and ending alphanumeric',
      'INVALID_AGENT_HANDLE',
    );
  }

  const wanted = [...new Set(input.projectIds)];
  if (wanted.length === 0) {
    throw badRequest(
      'projectIds must name at least one project — an agent with no project membership holds a credential fenced to nothing and cannot act',
      'AGENT_NEEDS_A_PROJECT',
    );
  }

  // cm:guard EVERY id is checked against this org, not just the first: a create that
  // validated one and enrolled the rest would let an org admin give their own agent a
  // membership in another org's project, which is the one thing a per-org admin gate
  // cannot otherwise be talked into. The refusal names the ids rather than the count,
  // because a caller sending eight gets no way to find the wrong one from a number.
  const found = await db
    .select({ id: projects.id, orgId: projects.orgId })
    .from(projects)
    .where(inArray(projects.id, wanted));
  const inThisOrg = new Set(found.filter((p) => p.orgId === input.orgId).map((p) => p.id));
  const strangers = wanted.filter((id) => !inThisOrg.has(id));
  if (strangers.length > 0) {
    throw new HTTPException(404, {
      message: `not a project of organization ${input.orgId}: ${strangers.join(', ')}`,
      cause: { code: 'NOT_FOUND' },
    });
  }

  const projectRole: ProjectMemberRole = input.projectRole ?? 'member';
  const email = synthesizeAgentEmail(input.handle);

  // cm:guard the `(org_id, handle)` index is the authority on uniqueness (criterion 12) and this turns its refusal into an ANSWER rather than a 500. Before the handle had a column two agents of one name both succeeded, so the constraint is new here and its bare `INTERNAL_ERROR` would be new too — a caller told nothing about the one field they must change. Caught around the transaction and not inside it, because the insert that violates it aborts the transaction whole: nothing partial is left to clean up, which is why this can name the handle and stop.
  const created = await mapHandleCollision(input, () =>
    db.transaction(async (tx) => {
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
      await tx
        .insert(projectMembers)
        .values(wanted.map((projectId) => ({ userId: row.id, projectId, role: projectRole })));
      return row;
    }),
  );

  // cm:guard the fence is RE-READ under the agent's lock rather than taken from `wanted`, and
  // this mint is the third of the three that had to be. The creation transaction has already
  // committed by now, so the agent is listable and an admin can widen its project set before
  // this token exists — and `setAgentProjects` re-fences only the tokens it can see. Locking
  // here makes either order correct, and it does NOT put the mint back inside the creation
  // transaction: its failure still leaves a tokenless agent the revoke route can remove, which
  // is the one recoverable partial state (ISS-1093, review finding F2).
  const minted = await withAgentFenceLock(created.id, async (tx) => {
    const fence = await agentCredentialFence(created.id, tx);
    return mintPat(
      { userId: created.id, name: `agent:${input.handle}`, scopes: ['read', 'write'], ...fence },
      tx,
    );
  });

  return {
    agent: {
      userId: created.id,
      handle: input.handle,
      displayName: input.handle,
      email,
      projects: wanted.map((id) => ({ id, role: projectRole })),
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

  // cm:guard the `leftJoin` on `project_members` yields ONE ROW PER MEMBERSHIP, so an
  // agent on three projects arrives here three times and a mapped-not-folded result
  // lists it three times — each copy naming a different project and every other column
  // identical, which reads as three agents sharing a name rather than as one agent
  // (ISS-1093). Folding is not an optimisation here; it is what makes the row count
  // mean "agents". The `leftJoin` stays a LEFT join because an agent with no project is
  // exactly the row an admin needs to see in order to fix it.
  const byAgent = new Map<string, AgentAccount>();
  for (const row of rows) {
    const activeTokens = row.activeTokens ?? 0;
    const existing = byAgent.get(row.userId);
    if (existing) {
      if (row.projectId)
        existing.projects.push({ id: row.projectId, role: row.projectRole ?? 'member' });
      existing.canAct = existing.activeTokens > 0 && existing.projects.length > 0;
      continue;
    }
    byAgent.set(row.userId, {
      userId: row.userId,
      handle: row.handle ?? '',
      displayName: row.displayName,
      email: row.email,
      projects: row.projectId ? [{ id: row.projectId, role: row.projectRole ?? 'member' }] : [],
      createdAt: row.createdAt,
      activeTokens,
      // cm:guard BOTH halves, because a live credential is only half of being able to act: the token is fenced to the agent's projects and `effectiveProjectRole` is what answers on the other side, so an agent whose project memberships were removed after its token was minted holds a credential that opens nothing. Reported as the credential fact alone, `reachOf`'s "belongs to no project" branch is unreachable and the console tells an admin to mint a second credential that will not help either (ISS-1003 criteria 2, 6, 7).
      canAct: activeTokens > 0 && row.projectId != null,
    });
  }
  return [...byAgent.values()];
}

/**
 * The agent of this org behind `agentUserId`, or null where there is none.
 *
 * Every credential route asks through here, so "is this id an agent of the org
 * the caller is admin of" is one question with one answer rather than three.
 */
export async function loadOrgAgent(
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
// cm:guard the token is fenced to the projects the agent is a member of, never unfenced, because an agent credentialed through this route would otherwise reach every project its account can see. Both fence shapes are narrow — `bound_project_id` for one, a non-empty `project_ids` allowlist for several — and NEITHER is a NULL pair, which is the account-scoped token `boundProjectId` exists to prevent (ISS-497). An agent with no project membership is refused by `agentCredentialFence` rather than given an unfenced one.
export async function mintAgentCredential(
  orgId: string,
  agentUserId: string,
): Promise<{ plaintext: string; fence: AgentCredentialFence } | null> {
  const agent = await loadOrgAgent(orgId, agentUserId);
  if (!agent) return null;

  // cm:guard the whole membership set, never `.limit(1)`. That is what this read used to
  // be, and against an agent on more than one project it picked whichever row Postgres
  // returned first and fenced the credential to it — a silent substitution that reads on
  // the box as "this project is gone" (a foreign-project PAT answers NOT_FOUND, which is
  // deliberately existence-hiding) rather than as a credential minted for the wrong reach.
  return withAgentFenceLock(agentUserId, async (tx) => {
    const fence = await agentCredentialFence(agentUserId, tx);
    const minted = await mintDistinctlyNamed(
      agent.id,
      `agent:${agent.handle ?? agent.id}`,
      fence,
      tx,
    );
    return { plaintext: minted, fence };
  });
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
  fence: AgentCredentialFence,
  tx: Tx = db,
): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const names = [base, `${base} ${stamp}`, `${base} ${randomBytes(4).toString('hex')}`];
  for (const name of names) {
    try {
      // cm:guard each attempt is its own SAVEPOINT (drizzle spells a nested transaction that
      // way), because this loop now runs INSIDE the fence lock's transaction: a unique violation
      // aborts the enclosing transaction whole, so an unnested retry would fail on every
      // remaining name with `current transaction is aborted` rather than on the constraint. That
      // is the price of minting under the lock, and it is paid here rather than by dropping the
      // retry (ISS-1093, review finding F2).
      const minted = await tx.transaction((sp) =>
        mintPat({ userId, name, scopes: ['read', 'write'], ...fence }, sp),
      );
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
 * Set the whole list of projects an agent works on, and re-fence what it holds.
 *
 * The membership write and the credential re-fence are ONE transaction on purpose.
 * Split them and there is a window where the agent is a member of a project none of
 * its credentials may reach, which on the box reads as `NOT_FOUND` — the deliberately
 * existence-hiding refusal a foreign-project token gets — so an operator sees "that
 * project is gone" rather than "your token has not caught up".
 */
// cm:guard EVERY live credential of this agent is re-fenced, including the one `devices/credential.ts:issueDeviceCredential` minted when a box paired as this agent. Narrowing this to the tokens THIS module minted is the obvious reading and it is wrong: the paired box's credential is the one that actually files the work, and leaving it on the old fence is exactly the "I added the project and the box still 404s" shape. Nothing here reads a token's NAME to decide — ISS-932 wave 4 removed name-derived behaviour, and a person's token called `agent:` must stay inert.
// cm:guard an agent's rights are its MEMBERSHIPS and this writes nothing else: no scope is added, no permission granted, no role raised. An agent reaches a project exactly as a person with the same `project_members` row does (`lib/authz.ts:effectiveProjectRole`), which is ISS-1093 rule 3, and a fence can only ever narrow that further.
export async function setAgentProjects(
  orgId: string,
  agentUserId: string,
  projectIds: string[],
): Promise<{ projects: string[]; fence: AgentCredentialFence; refenced: number } | null> {
  if (!(await loadOrgAgent(orgId, agentUserId))) return null;

  const wanted = [...new Set(projectIds)];
  if (wanted.length === 0) {
    throw badRequest(
      'projectIds must name at least one project — removing the last one would leave a credential fenced to nothing; retire the agent instead',
      'AGENT_NEEDS_A_PROJECT',
    );
  }

  const found = await db
    .select({ id: projects.id, orgId: projects.orgId })
    .from(projects)
    .where(inArray(projects.id, wanted));
  const inThisOrg = new Set(found.filter((p) => p.orgId === orgId).map((p) => p.id));
  const strangers = wanted.filter((id) => !inThisOrg.has(id));
  if (strangers.length > 0) {
    throw new HTTPException(404, {
      message: `not a project of organization ${orgId}: ${strangers.join(', ')}`,
      cause: { code: 'NOT_FOUND' },
    });
  }

  // cm:guard refuse to widen the ONE account whose widening a project cannot recover from: the
  // agent that is a project's conversational voice AND carries the slug-derived name that
  // project's handle is minted under. Widened, it stops qualifying as a candidate
  // (`existingProjectHandle` requires a single membership), and the next room opened there mints
  // a replacement under that same name — which `(org_id, handle)` refuses, by a decision ISS-1003
  // took deliberately and which this change does not get to reverse. So the collision is
  // prevented rather than absorbed, and the refusal names the way out.
  //
  // It is deliberately NOT "any agent that is currently a project's only agent": an agent an
  // admin named `forge-vm` on project `alpha` is also that project's voice today, and widening it
  // is exactly what ISS-1093 is for — `alpha` simply mints `alpha` next time, with nothing in the
  // way. Only the name makes the difference, so only the name is tested (ISS-1093).
  const held = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, agentUserId));
  const only = held.length === 1 ? (held[0]?.projectId as string) : null;
  if (only && !(wanted.length === 1 && wanted[0] === only)) {
    const [p] = await db
      .select({ slug: projects.slug, id: projects.id })
      .from(projects)
      .where(eq(projects.id, only))
      .limit(1);
    const [me] = await db
      .select({ handle: organizationMembers.handle })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, agentUserId))
      .limit(1);
    const voice = await existingProjectHandle(db, only);
    if (p && voice?.userId === agentUserId && me?.handle === handleNameForProject(p.slug, p.id)) {
      throw new HTTPException(409, {
        message: `agent ${agentUserId} is the conversational handle of project ${only} and carries the name that project's handle is minted under (@${me.handle}) — widening it would leave that project unable to mint a replacement, so its rooms would stop opening; create a separate agent for the projects you want covered and leave this one where it is`,
        cause: { code: 'AGENT_IS_A_PROJECT_HANDLE' },
      });
    }
  }

  const fence = fenceFor(wanted);
  const refenced = await withAgentFenceLock(agentUserId, async (tx) => {
    // cm:guard a project the agent ALREADY works on keeps the role it already holds. Rewriting
    // every row as `member` is what this did, and it made a set operation a silent permission
    // change in both directions: a `viewer` agent was promoted and an `admin` one demoted by a
    // PUT that named the very same projects. `member` is the default for a project being ADDED
    // and nothing else — the sentence below this one says no role is raised here, and this is
    // what makes that true (ISS-1093, review finding F3).
    const held = new Map(
      (
        await tx
          .select({ projectId: projectMembers.projectId, role: projectMembers.role })
          .from(projectMembers)
          .where(eq(projectMembers.userId, agentUserId))
      ).map((r) => [r.projectId, r.role]),
    );
    await tx.delete(projectMembers).where(eq(projectMembers.userId, agentUserId));
    await tx.insert(projectMembers).values(
      wanted.map((projectId) => ({
        userId: agentUserId,
        projectId,
        role: held.get(projectId) ?? ('member' as const),
      })),
    );
    const rows = await tx
      .update(personalAccessTokens)
      .set({ boundProjectId: fence.boundProjectId, projectIds: fence.projectIds })
      .where(and(eq(personalAccessTokens.userId, agentUserId), patIsLive()))
      .returning({ id: personalAccessTokens.id });
    return rows.length;
  });

  return { projects: wanted, fence, refenced };
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
