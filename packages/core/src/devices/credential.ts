import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { lockPatName, mintPat } from '../auth/pat.js';
import { deviceTokenNameFor } from '../auth/pat-format.js';
import { env } from '../config/env.js';
import { db, type Tx } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import { agentCredentialFence, withAgentFenceLock } from '../orgs/agent-fence.js';

const DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE = 600;

export function hashMachineId(raw: string): string {
  return createHash('sha256').update(`${raw}:${env.DEVICE_TOKEN_PEPPER}`).digest('hex');
}

/**
 * Issue the token a box authenticates with — the plaintext exists only here.
 * Revoke and mint are ONE transaction under {@link lockPatName}, or a re-pair
 * meeting a login both revoke before either inserts and `pat_user_name_uniq`
 * refuses the second. The revoke reaches that name WHOEVER holds it, since a box
 * has one identity and `deviceHolderUserId` reads an arbitrary one of two live
 * rows (ISS-1184). An agent holder locks inside the fence lock.
 */
export async function issueDeviceCredential(args: {
  deviceId: string;
  /** The principal the box acts as — a person, or an agent (ISS-932). */
  holderUserId: string;
  /** An agent holder fences the box to that agent's projects, not to none (ISS-1093). */
  holderIsAgent?: boolean;
}): Promise<string> {
  const name = deviceTokenNameFor(args.deviceId);
  const common = {
    userId: args.holderUserId,
    name,
    scopes: ['read', 'write'],
    deviceId: args.deviceId,
    rateLimitMax: DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE,
  };

  const supersede = async (tx: Tx) => {
    await lockPatName(tx, name);
    await tx
      .update(personalAccessTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(personalAccessTokens.name, name), isNull(personalAccessTokens.revokedAt)));
  };

  if (!args.holderIsAgent) {
    return db.transaction(async (tx) => {
      await supersede(tx);
      const { plaintext } = await mintPat({ ...common, projectIds: [] }, tx);
      return plaintext;
    });
  }
  return withAgentFenceLock(args.holderUserId, async (tx) => {
    await supersede(tx);
    const fence = await agentCredentialFence(args.holderUserId, tx);
    const { plaintext } = await mintPat({ ...common, ...fence }, tx);
    return plaintext;
  });
}

/** Revoke every live credential issued to a box, so unpairing takes its reach with it. */
export async function revokeDeviceCredentials(deviceId: string): Promise<number> {
  const rows = await db
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(personalAccessTokens.deviceId, deviceId), isNull(personalAccessTokens.revokedAt)))
    .returning({ id: personalAccessTokens.id });
  return rows.length;
}
