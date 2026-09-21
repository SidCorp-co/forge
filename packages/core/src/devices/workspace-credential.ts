/**
 * The credential a provisioned checkout carries in its `.mcp.json`.
 *
 * Provisioning writes that file so a person running `claude` in the folder
 * reaches Forge. The box's own device credential cannot serve it: for a human
 * holder it is fenced to no project at all (`projectIds: []`, which
 * `visibleProjectsWhere` turns into `false`), so the entry would authenticate
 * and then see nothing. Before this, the box needed a PAT pasted in by hand,
 * and a UI-driven assignment could not finish on the machine.
 *
 * So the server mints one per (device × project), because the server is where
 * both the identity the box acts as and that identity's reach are known. It is
 * NARROWER than the token a person would have pasted: fenced to this one
 * project, named after the pair so it is revocable on its own, and revoked
 * along with every other credential of the device when the device is revoked
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
 * to carry the token mints a fresh one rather than reading the old back; the
 * old is revoked in the same breath so a checkout that was re-provisioned
 * leaves no live credential behind it.
 */
export async function issueWorkspaceCredential(args: {
  deviceId: string;
  projectId: string;
  holderUserId: string;
}): Promise<string> {
  const name = workspaceTokenNameFor(args.deviceId, args.projectId);
  await db
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(personalAccessTokens.name, name), isNull(personalAccessTokens.revokedAt)));

  const { plaintext } = await mintPat({
    userId: args.holderUserId,
    name,
    scopes: ['read', 'write'],
    projectIds: [args.projectId],
    deviceId: args.deviceId,
  });
  return plaintext;
}
