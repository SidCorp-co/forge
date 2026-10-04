import { createHash } from 'node:crypto';
import { lockPatName, mintPat, revokeLiveTokens, supersedeNamedToken } from '../credentials/pat.js';
import { deviceTokenNameFor } from '../credentials/pat-format.js';
import { PAT_GRANT_ALL } from '../credentials/pat-permissions.js';
import { env } from '../config/env.js';
import { db, type Tx } from '../db/client.js';
import { agentCredentialFence, withAgentFenceLock } from '../orgs/agent-fence.js';

const DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE = 600;

export function hashMachineId(raw: string): string {
  return createHash('sha256').update(`${raw}:${env.DEVICE_TOKEN_PEPPER}`).digest('hex');
}

/**
 * Issue the token a box authenticates with — the plaintext exists only here.
 * Revoke and mint are ONE transaction under {@link lockPatName}. The revoke
 * takes that name from THIS DEVICE or THIS HOLDER (ISS-1184): a box that changed
 * hands must leave the previous holder none, and the holder's own token of that
 * name must go or the mint collides — `POST /api/pat` reserves no prefix and
 * sets no `device_id`. A third party's borrowed name is neither, and stands.
 */
export async function issueDeviceCredential(args: {
  deviceId: string;
  /** The principal the box acts as — a person, or an agent (ISS-932). */
  holderUserId: string;
  /** An agent holder fences the box to that agent's projects, not to none (ISS-1093). */
  holderIsAgent?: boolean;
  /** The epoch of whoever authorised the pairing: see `mintPat`. */
  grantEpoch?: number;
}): Promise<string> {
  const name = deviceTokenNameFor(args.deviceId);
  const common = {
    userId: args.holderUserId,
    name,
    scopes: ['read', 'write'],
    deviceId: args.deviceId,
    rateLimitMax: DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE,
    grantEpoch: args.grantEpoch,
  };

  const supersede = async (tx: Tx) => {
    await lockPatName(tx, name);
    await supersedeNamedToken(tx, name, { deviceId: args.deviceId, userId: args.holderUserId });
  };

  if (!args.holderIsAgent) {
    return db.transaction(async (tx) => {
      await supersede(tx);
      const { plaintext } = await mintPat(
        { ...common, permissions: PAT_GRANT_ALL, projectIds: [] },
        tx,
      );
      return plaintext;
    });
  }
  return withAgentFenceLock(args.holderUserId, async (tx) => {
    await supersede(tx);
    const fence = await agentCredentialFence(args.holderUserId, tx);
    const { plaintext } = await mintPat({ ...common, permissions: PAT_GRANT_ALL, ...fence }, tx);
    return plaintext;
  });
}

/** Revoke every live credential issued to a box, so unpairing takes its reach with it. */
export async function revokeDeviceCredentials(deviceId: string): Promise<number> {
  return revokeLiveTokens({ deviceId });
}
