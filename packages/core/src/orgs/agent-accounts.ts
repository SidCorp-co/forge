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
import { handleNameForProject } from '../conversations/handles.js';
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

  const created = await mapHandleCollision(input, () =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          email,
          kind: 'agent',
          passwordHash: null,
          emailVerifiedAt: new Date(),
          displayName: input.handle,
        })
        .returning({ id: users.id, createdAt: users.createdAt });
      if (!row) throw new Error('createAgentAccount: user insert returned no row');

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
export async function mintAgentCredential(
  orgId: string,
  agentUserId: string,
): Promise<{ plaintext: string; fence: AgentCredentialFence } | null> {
  const agent = await loadOrgAgent(orgId, agentUserId);
  if (!agent) return null;

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
    if (p && me?.handle === handleNameForProject(p.slug, p.id)) {
      throw new HTTPException(409, {
        message: `agent ${agentUserId} carries the name project ${only}'s conversational handle is minted under (@${me.handle}) — widening it would leave that project unable to mint a replacement, so its rooms would stop opening; create a separate agent for the projects you want covered and leave this one where it is`,
        cause: { code: 'AGENT_IS_A_PROJECT_HANDLE' },
      });
    }
  }

  const fence = fenceFor(wanted);
  const refenced = await withAgentFenceLock(agentUserId, async (tx) => {
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
