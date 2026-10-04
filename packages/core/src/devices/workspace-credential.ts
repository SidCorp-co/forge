/**
 * The credential a provisioned checkout carries in its `.mcp.json`.
 *
 * The box's own device credential cannot serve it: for a human holder it is
 * fenced to no project at all (`projectIds: []`, which `visibleProjectsWhere`
 * turns into `false`), so the entry would authenticate and see nothing. The
 * server mints one per (device × project) instead, being where both the
 * identity the box acts as and that identity's reach are known. It is NARROWER
 * than a hand-pasted token: fenced to one project, named after the pair so it
 * is revocable on its own, and revoked with the device
 * (`revokeDeviceCredentials`).
 *
 * The pane that reads it is the project's master, which is the project's own
 * AGENT: what only that agent may write — a builder run, a link — is refused
 * to a person (`writerRefusal`). So the credential is held by an agent, never
 * by the person who paired the box: a box paired as an agent keeps its agent,
 * and a box paired by a person carries the project's own agent account
 * (`resolveProjectHandle`), handed only by a person holding member or above on
 * that project. One path for every project bound on the box, and each
 * checkout's token reaches its own project alone.
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { lockPatName, mintPat } from '../auth/pat.js';
import { deviceTokenNameFor, workspaceTokenNameFor } from '../auth/pat-format.js';
import { PAT_GRANT_ALL } from '../auth/pat-permissions.js';
import { resolveProjectHandle } from '../conversations/handles.js';
import { db } from '../db/client.js';
import { personalAccessTokens, users } from '../db/schema.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { holds } from '../permissions/index.js';

/**
 * Who the box acts as: the holder of its live device credential, which is the
 * approving person or — when it was paired as one — the agent. Null when the
 * device has no live credential, in which case it could not be asking.
 */
export async function deviceHolderUserId(deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: personalAccessTokens.userId })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.deviceId, deviceId),
        eq(personalAccessTokens.name, deviceTokenNameFor(deviceId)),
        isNull(personalAccessTokens.revokedAt),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Mint this device's credential for one project's checkout, superseding the
 * previous one. A PAT's plaintext exists only at mint, so a delivery that has
 * to carry the token mints a fresh one rather than reading the old back.
 *
 * Revoke and mint are ONE transaction under an advisory lock on the token name
 * (ISS-1184), which buys two things. A mint that fails leaves the checkout the
 * credential it had, rather than a revoked one and nothing to replace it. And
 * two requests for the same checkout — the ninety-second sweep meeting a
 * `provision.request` — are ordered, which is the one way `pat_user_name_uniq`
 * can still refuse a mint now that it is partial on `revoked_at is null`.
 */
export async function issueWorkspaceCredential(args: {
  deviceId: string;
  projectId: string;
  holderUserId: string;
}): Promise<string> {
  const name = workspaceTokenNameFor(args.deviceId, args.projectId);
  return db.transaction(async (tx) => {
    await lockPatName(tx, name);
    const [parent] = await tx
      .select({ grantEpoch: personalAccessTokens.grantEpoch })
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.deviceId, args.deviceId),
          eq(personalAccessTokens.name, deviceTokenNameFor(args.deviceId)),
          isNull(personalAccessTokens.revokedAt),
        ),
      )
      .limit(1);
    await tx
      .update(personalAccessTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(personalAccessTokens.name, name),
          isNull(personalAccessTokens.revokedAt),
          or(
            eq(personalAccessTokens.deviceId, args.deviceId),
            eq(personalAccessTokens.userId, args.holderUserId),
          ),
        ),
      );

    const { plaintext } = await mintPat(
      {
        userId: args.holderUserId,
        name,
        scopes: ['read', 'write'],
        permissions: PAT_GRANT_ALL,
        projectIds: [args.projectId],
        deviceId: args.deviceId,
        grantEpoch: parent?.grantEpoch ?? 1,
      },
      tx,
    );
    return plaintext;
  });
}

/** A checkout whose credential no agent can hold, refused by name rather than minted as the person. */
export class WorkspaceHolderRefused extends Error {
  readonly code = 'WORKSPACE_HOLDER_REFUSED';
}

// A master pane is its project's agent, so the checkout carries the agent's identity; a person hands it only holding project.write.
/**
 * Who a checkout's credential is held by: the device's holder where that is an
 * agent, and the project's own agent where it is a person entitled to hand it.
 */
export async function workspaceHolderFor(args: {
  deviceHolderUserId: string;
  projectId: string;
}): Promise<string> {
  const [holder] = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, args.deviceHolderUserId))
    .limit(1);
  if (!holder) {
    throw new WorkspaceHolderRefused(
      `the device's holder ${args.deviceHolderUserId} is not a user, so no credential is minted for project ${args.projectId}'s checkout`,
    );
  }
  if (holder.kind === 'agent') return args.deviceHolderUserId;
  const access = await effectiveProjectRole(args.deviceHolderUserId, args.projectId);
  if (!access || !holds(access, 'project.write')) {
    throw new WorkspaceHolderRefused(
      `person ${args.deviceHolderUserId} paired this box and holds ${access?.role ?? 'no role'} on project ${args.projectId}; its checkout's credential acts as the project's own agent, which only a holder of project.write hands a box. A project admin raises their role, or the box is paired as an agent of the project`,
    );
  }
  return db.transaction(async (tx) => (await resolveProjectHandle(tx, args.projectId)).userId);
}

/** The credential a provisioned checkout carries: held by {@link workspaceHolderFor}, minted by {@link issueWorkspaceCredential}. */
export async function issueCheckoutCredential(args: {
  deviceId: string;
  projectId: string;
  holderUserId: string;
}): Promise<string> {
  const holderUserId = await workspaceHolderFor({
    deviceHolderUserId: args.holderUserId,
    projectId: args.projectId,
  });
  return issueWorkspaceCredential({ ...args, holderUserId });
}
