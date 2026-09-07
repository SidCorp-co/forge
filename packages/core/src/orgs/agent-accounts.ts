/**
 * Agent Access Tokens — the writer for "this org has a named agent" (ISS-932).
 *
 * Everything an agent gets, it gets from machinery a person already used: a
 * `users` row, an `organization_members` row, a `project_members` row and a
 * PAT from `mintPat`. There is no agent-shaped authorization path, which is
 * the point — `effectiveProjectRole` and the membership reads behind it never
 * learn that agents exist.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { isAgentHandle, synthesizeAgentEmail } from '../auth/agent-account.js';
import { mintPat } from '../auth/pat.js';
import { db } from '../db/client.js';
import {
  organizationMembers,
  type ProjectMemberRole,
  personalAccessTokens,
  projectMembers,
  projects,
  users,
} from '../db/schema.js';

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
  email: string;
  projectId: string;
  projectRole: ProjectMemberRole;
  createdAt: Date;
  /** Live (non-revoked) token count — an agent with none cannot act. */
  activeTokens: number;
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
      })
      .returning({ id: users.id, createdAt: users.createdAt });
    if (!row) throw new Error('createAgentAccount: user insert returned no row');

    // cm:guard `member`, never `admin`. Org admin is what MANAGES agents (mint, revoke); an agent holding it could create further agents and grant them anything, which is the credential-mints-credential hole `/api/pat`'s absence from `PAT_ALLOWED_PREFIXES` closes on the other side.
    await tx.insert(organizationMembers).values({
      orgId: input.orgId,
      userId: row.id,
      role: 'member',
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
      email,
      projectId: input.projectId,
      projectRole,
      createdAt: created.createdAt,
      activeTokens: 1,
    },
    plaintext: minted.plaintext,
  };
}

export async function listAgentAccounts(orgId: string): Promise<AgentAccount[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      createdAt: users.createdAt,
      projectId: projectMembers.projectId,
      projectRole: projectMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(projectMembers, eq(projectMembers.userId, users.id))
    .where(and(eq(organizationMembers.orgId, orgId), eq(users.kind, 'agent')))
    .orderBy(desc(users.createdAt));

  const out: AgentAccount[] = [];
  for (const row of rows) {
    const live = await db
      .select({ id: personalAccessTokens.id })
      .from(personalAccessTokens)
      .where(
        and(eq(personalAccessTokens.userId, row.userId), isNull(personalAccessTokens.revokedAt)),
      );
    out.push({
      userId: row.userId,
      handle: row.email.split('.')[0] ?? row.email,
      email: row.email,
      projectId: row.projectId ?? '',
      projectRole: row.projectRole ?? 'member',
      createdAt: row.createdAt,
      activeTokens: live.length,
    });
  }
  return out;
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
