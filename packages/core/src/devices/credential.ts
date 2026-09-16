/**
 * How a paired box gets a credential, now that there is not a device-shaped
 * one (ISS-932).
 *
 * Pairing used to mint a bespoke argon2 secret into `devices.token_hash`. It
 * now issues an ordinary `personal_access_tokens` row carrying the box's id in
 * `device_id` — a PAT when a person pairs the box, an AAT when a named agent
 * does. `requireDevice`, `requireUserOrDevice` and `/ws` read the device back
 * off that column.
 */

import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { mintPat } from '../auth/pat.js';
import { deviceTokenNameFor } from '../auth/pat-format.js';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';

const DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE = 600;

/**
 * Deterministic, non-reversible fingerprint of a host's machine id. Used as the
 * dedup key so the raw `/etc/machine-id` is never stored (systemd advises
 * hashing it before exposing externally). Plain sha256 (not argon2) because it
 * must be reproducible for equality lookups.
 */
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

  const { plaintext } = await mintPat({
    userId: args.holderUserId,
    name,
    scopes: ['read', 'write'],
    projectIds: [],
    deviceId: args.deviceId,
    rateLimitMax: DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE,
  });
  return plaintext;
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
