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
import { agentCredentialFence, withAgentFenceLock } from '../orgs/agent-fence.js';

// cm:guard pinned rather than inherited from `RULES.patRead`/`RULES.patWrite`: those defaults are operator knobs (`RATE_LIMIT_PAT_READ_MAX`, `RATE_LIMIT_PAT_WRITE_MAX`) and the read one is sized for a whole box of sessions, which a single box credential is not. A box does not degrade under a 429, it stops claiming. A daemon heartbeats, polls the pool for every binding and streams job events on one token, so it is the noisiest credential in the fleet and the least able to ask for another.
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
// cm:guard the previous token for this box is revoked and RENAMED first: `pat_user_name_uniq` is on (user_id, name), and a re-pair from the same machine rotates the SAME `devices` row, so a second mint under the live name violates the index and the whole pairing fails. Renaming rather than deleting keeps the record of what the box held before.
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

  // cm:guard the fence is NEVER `null` on either branch, and `null` is the bug both branches
  // exist to prevent: it means "its holder's projects", which for a person is the whole
  // account and is the `device.ownerId` fiction returning in a new shape.
  //
  // A PERSON's box keeps `[]` — no project at all (`effectiveProjectRole` returns null for
  // every id). That is right because the surfaces a person's box legitimately needs go
  // through `requireDevice`, which resolves the DEVICE and never consults this fence.
  //
  // An AGENT's box is fenced to that agent's own projects, and this is not a widening of
  // the line above: the same credential is written into every job's `.mcp.json`
  // (`forge-runner-core/src/mcp/config.rs`), so under `[]` a box paired as an agent could
  // run the daemon plane and not make a single project-scoped call — which is why
  // forge-vm was holding a person's PAT in the first place (ISS-1093). The agent's reach
  // is its memberships either way; this only stops the token being wider than they are.
  const common = {
    userId: args.holderUserId,
    name,
    scopes: ['read', 'write'],
    deviceId: args.deviceId,
    rateLimitMax: DEVICE_TOKEN_RATE_LIMIT_PER_MINUTE,
  };

  // cm:guard an AGENT's box reads its fence and inserts its token inside the agent's fence
  // lock, on one connection. This is the credential that actually files the work, so a project
  // set widened between the read and the insert would leave the box a project short of what the
  // admin committed, with no later re-fence coming for a row that did not exist yet — the exact
  // "I added the project and it still 404s" shape `setAgentProjects` exists to remove
  // (ISS-1093, review finding F2). A PERSON's box takes no lock: its fence is the constant `[]`
  // and nothing re-fences it.
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
