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
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { mintPat } from '../auth/pat.js';
import { deviceTokenNameFor, workspaceTokenNameFor } from '../auth/pat-format.js';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';

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
 * can still refuse a mint now that it is partial on `revoked_at is null`. The
 * lock shape is `orgs/agent-fence.ts:withAgentFenceLock`'s.
 */
export async function issueWorkspaceCredential(args: {
  deviceId: string;
  projectId: string;
  holderUserId: string;
}): Promise<string> {
  const name = workspaceTokenNameFor(args.deviceId, args.projectId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
    await tx
      .update(personalAccessTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(personalAccessTokens.name, name), isNull(personalAccessTokens.revokedAt)));

    const { plaintext } = await mintPat(
      {
        userId: args.holderUserId,
        name,
        scopes: ['read', 'write'],
        projectIds: [args.projectId],
        deviceId: args.deviceId,
      },
      tx,
    );
    return plaintext;
  });
}
