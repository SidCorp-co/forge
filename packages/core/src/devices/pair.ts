import { eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { type Device, type IssueDeviceTokenInput, issueDeviceToken } from '../auth/deviceToken.js';
import { db } from '../db/client.js';
import { pairingCodes } from '../db/schema.js';

export interface PairInput extends Omit<IssueDeviceTokenInput, 'ownerId'> {
  code: string;
}

export interface PairResult {
  device: Device;
  plaintext: string;
  projectId: string | null;
}

const badRequest = (code: string, message: string) =>
  new HTTPException(400, { message, cause: { code } });

/**
 * Atomically redeem a pairing code and issue a device token.
 *
 * Behaviour:
 *  - INVALID_CODE — code not found
 *  - CODE_ALREADY_USED — `usedAt` is not null
 *  - CODE_EXPIRED — `expiresAt < now()`
 *  - On success, issues a device token bound to the code's owner.
 *
 * Pairing is device-scoped: redeeming a code mints a token, never binds the
 * device to a project. Project binding is a separate web-UI action driven by
 * `POST /projects/:id/runners` (ISS-172 Slice A).
 *
 * `projectId` on the result echoes back the code's hint so the desktop client
 * can still surface "you were invited to project X"; it has no DB side-effect.
 */
export async function redeemPairingCode(input: PairInput): Promise<PairResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      code: string;
      user_id: string;
      project_id: string | null;
      expires_at: Date;
      used_at: Date | null;
    }>(sql`SELECT code, user_id, project_id, expires_at, used_at
           FROM pairing_codes
           WHERE code = ${input.code}
           FOR UPDATE`);
    const row = rows[0];
    if (!row) throw badRequest('INVALID_CODE', 'invalid pairing code');
    if (row.used_at !== null) {
      throw badRequest('CODE_ALREADY_USED', 'pairing code already used');
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw badRequest('CODE_EXPIRED', 'pairing code expired');
    }

    const { device, plaintext } = await issueDeviceToken({
      ownerId: row.user_id,
      name: input.name,
      platform: input.platform,
      agentVersion: input.agentVersion ?? null,
      capabilities: input.capabilities,
    });

    await tx
      .update(pairingCodes)
      .set({ usedAt: new Date() })
      .where(eq(pairingCodes.code, input.code));

    return { device, plaintext, projectId: row.project_id };
  });
}
