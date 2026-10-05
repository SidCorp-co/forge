import { eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { type Device, pairingCodes } from '../db/schema.js';
import { issueDeviceCredential } from './credential.js';
import { type RegisterDeviceInput, registerDevice } from './register.js';

interface PairInput extends Omit<RegisterDeviceInput, 'ownerId'> {
  code: string;
}

interface PairResult {
  device: Device;
  plaintext: string;
  projectId: string | null;
}

const badRequest = (code: string, message: string) =>
  new HTTPException(400, { message, cause: { code } });

export async function redeemPairingCode(input: PairInput): Promise<PairResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      code: string;
      user_id: string;
      project_id: string | null;
      expires_at: Date;
      used_at: Date | null;
      grant_epoch: number;
    }>(sql`SELECT code, user_id, project_id, expires_at, used_at, grant_epoch
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

    // Every write below runs on the code's own transaction: a failed mint takes the device row
    // and the spent code back with it, so a retry with the same code cannot pair a second box.
    const device = await registerDevice(
      {
        ownerId: row.user_id,
        name: input.name,
        platform: input.platform,
        agentVersion: input.agentVersion ?? null,
        capabilities: input.capabilities,
        machineId: input.machineId ?? null,
      },
      tx,
    );

    await tx
      .update(pairingCodes)
      .set({ usedAt: new Date() })
      .where(eq(pairingCodes.code, input.code));

    const plaintext = await issueDeviceCredential({
      deviceId: device.id,
      holderUserId: row.user_id,
      grantEpoch: row.grant_epoch,
      tx,
    });

    return { device, plaintext, projectId: row.project_id };
  });
}
