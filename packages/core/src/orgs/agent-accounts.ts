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
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { insertAgentAccount, setUserDisplayName } from '../auth/index.js';
import { isAgentHandle } from '../credentials/agent-account.js';
import { mintPat, revokeLiveTokens } from '../credentials/pat.js';
import { patIsLive } from '../credentials/pat-live.js';
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
  addOrgMember,
  addProjectMembers,
  agentCredentialFence,
  agentCredentialGrant,
  withAgentFenceLock,
} from '../permissions/index.js';
import { refuse } from './refuse.js';

const badRequest = (message: string, code: string) =>
  new HTTPException(400, { message, cause: { code } });

/**
 * How long an agent account's credential lives: a year, the longest a fine-grained personal token
 * may be set to live on GitHub. Minting a fresh one is the org admin's act.
 */
const AGENT_CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const agentCredentialExpiry = () => new Date(Date.now() + AGENT_CREDENTIAL_TTL_MS);

interface CreateAgentAccountInput {
  orgId: string;
  /** The menu epoch the agent's credential is fixed at: see `mintPat`. */
  grantEpoch?: number;
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

interface AgentAccount {
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
      throw refuse(
        'AGENT_HANDLE_TAKEN',
        `@${input.handle} is already an agent of organization ${input.orgId}; a handle is the address typed after @ and one org holds one of each, so give this agent a different handle or rename the one that has it`,
        '/handle',
      );
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
  const created = await mapHandleCollision(input, () =>
    db.transaction(async (tx) => {
      const row = await insertAgentAccount(tx, input.handle);

      await addOrgMember(tx, {
        orgId: input.orgId,
        userId: row.id,
        role: 'member',
        handle: input.handle,
      });
      await addProjectMembers(
        tx,
        wanted.map((projectId) => ({ userId: row.id, projectId, role: projectRole })),
      );
      return row;
    }),
  );

  const minted = await withAgentFenceLock(created.id, async (tx) => {
    const fence = await agentCredentialFence(created.id, tx);
    return mintPat(
      {
        userId: created.id,
        name: `agent:${input.handle}`,
        scopes: ['read', 'write'],
        permissions: await agentCredentialGrant(created.id, tx),
        grantEpoch: input.grantEpoch,
        expiresAt: agentCredentialExpiry(),
        ...fence,
      },
      tx,
    );
  });

  return {
    agent: {
      userId: created.id,
      handle: input.handle,
      displayName: input.handle,
      email: created.email,
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
  grantEpoch?: number,
): Promise<{ plaintext: string; fence: AgentCredentialFence } | null> {
  const agent = await loadOrgAgent(orgId, agentUserId);
  if (!agent) return null;

  return withAgentFenceLock(agentUserId, async (tx) => {
    const fence = await agentCredentialFence(agentUserId, tx);
    const minted = await mintDistinctlyNamed(
      agent.id,
      `agent:${agent.handle ?? agent.id}`,
      { ...fence, grantEpoch },
      tx,
    );
    return { plaintext: minted, fence };
  });
}

/**
 * Mint under a name `pat_user_name_uniq` will accept, escalating rather than looping.
 *
 * `pat_user_name_uniq` is unique on `(user_id, name)` among LIVE rows only
 * (partial on `revoked_at is null`, ISS-1184), so the obvious `agent:<handle>`
 * collides while the agent still holds a live credential of that name — which
 * is what happens when an admin credentials the same agent again without
 * taking the previous one away first.
 */
async function mintDistinctlyNamed(
  userId: string,
  base: string,
  fence: AgentCredentialFence & { grantEpoch?: number | undefined },
  tx: Tx = db,
): Promise<string> {
  const permissions = await agentCredentialGrant(userId, tx);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const names = [base, `${base} ${stamp}`, `${base} ${randomBytes(4).toString('hex')}`];
  for (const name of names) {
    try {
      const minted = await tx.transaction((sp) =>
        mintPat(
          {
            userId,
            name,
            scopes: ['read', 'write'],
            permissions,
            expiresAt: agentCredentialExpiry(),
            ...fence,
          },
          sp,
        ),
      );
      return minted.plaintext;
    } catch (err) {
      if (!isUniqueViolation(err) || uniqueViolationConstraint(err) !== 'pat_user_name_uniq') {
        throw err;
      }
    }
  }
  throw badRequest(
    `every name this route would give a credential for agent ${userId} is held by a live token (${names.join(', ')}); ask again and the third name is drawn fresh, or revoke one of those tokens — pat_user_name_uniq is partial on revoked_at is null, so revoking frees the name`,
    'AGENT_CREDENTIAL_NAME_TAKEN',
  );
}
/**
 * Take every live credential away from an agent, leaving the account standing.
 */
export async function revokeAgentCredentials(
  orgId: string,
  agentUserId: string,
): Promise<number | null> {
  if (!(await loadOrgAgent(orgId, agentUserId))) return null;
  return revokeLiveTokens({ userId: agentUserId });
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
  return (await setUserDisplayName(agentUserId, displayName)) ?? null;
}
