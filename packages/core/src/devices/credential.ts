import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { mintPat } from '../auth/pat.js';
import { deviceTokenNameFor } from '../auth/pat-format.js';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import { agentCredentialFence, withAgentFenceLock } from '../orgs/agent-fence.js';

const DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE = 600;

export function hashMachineId(raw: string): string {
  return createHash('sha256').update(`${raw}:${env.DEVICE_TOKEN_PEPPER}`).digest('hex');
}

/**
 * Issue the token a box authenticates with. Returns the plaintext, which is
 * the only time it exists.
 */
export async function issueDeviceCredential(args: {
  deviceId: string;
  /** The principal the box acts as — a person, or an agent (ISS-932). */
  holderUserId: string;
  /**
   * True when the holder is an agent account, so the box's credential is fenced to
   * that agent's projects instead of to none (ISS-1093).
   */
  holderIsAgent?: boolean;
}): Promise<string> {
  const name = deviceTokenNameFor(args.deviceId);
  await db
    .update(personalAccessTokens)
    .set({
      name: sql`${personalAccessTokens.name} || '.superseded.' || extract(epoch from now())::bigint`,
      revokedAt: sql`now()`,
    })
    .where(
      and(
        eq(personalAccessTokens.userId, args.holderUserId),
        eq(personalAccessTokens.name, name),
        isNull(personalAccessTokens.revokedAt),
      ),
    );

  const common = {
    userId: args.holderUserId,
    name,
    scopes: ['read', 'write'],
    deviceId: args.deviceId,
    rateLimitMax: DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE,
  };

  if (!args.holderIsAgent) {
    const { plaintext } = await mintPat({ ...common, projectIds: [] });
    return plaintext;
  }
  return withAgentFenceLock(args.holderUserId, async (tx) => {
    const fence = await agentCredentialFence(args.holderUserId, tx);
    const { plaintext } = await mintPat({ ...common, ...fence }, tx);
    return plaintext;
  });
}

/**
 * Revoke every live credential issued to a box. Called when the device itself
 * is revoked, so unpairing a machine takes its reach with it.
 */
export async function revokeDeviceCredentials(deviceId: string): Promise<number> {
  const rows = await db
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(personalAccessTokens.deviceId, deviceId), isNull(personalAccessTokens.revokedAt)))
    .returning({ id: personalAccessTokens.id });
  return rows.length;
}
