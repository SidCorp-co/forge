import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { eq, type InferSelectModel } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { type DevicePlatform, devices } from '../db/schema.js';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const TOKEN_BYTES = 32;
const PREFIX_LEN = 8;

export type Device = InferSelectModel<typeof devices>;

export interface IssueDeviceTokenInput {
  ownerId: string;
  name: string;
  platform: DevicePlatform;
  agentVersion?: string | null;
  capabilities?: unknown;
}

export interface IssuedDeviceToken {
  device: Device;
  plaintext: string;
}

export async function issueDeviceToken(input: IssueDeviceTokenInput): Promise<IssuedDeviceToken> {
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenPrefix = plaintext.slice(0, PREFIX_LEN);
  const tokenHash = await argon2.hash(plaintext + env.DEVICE_TOKEN_PEPPER, ARGON2_OPTIONS);

  const [device] = await db
    .insert(devices)
    .values({
      ownerId: input.ownerId,
      name: input.name,
      platform: input.platform,
      agentVersion: input.agentVersion ?? null,
      tokenHash,
      tokenPrefix,
      capabilities: input.capabilities ?? null,
    })
    .returning();

  if (!device) {
    throw new Error('issueDeviceToken: insert returned no row');
  }

  return { device, plaintext };
}

export async function verifyDeviceToken(plaintext: unknown): Promise<Device | null> {
  if (typeof plaintext !== 'string' || plaintext.length <= PREFIX_LEN) return null;
  const prefix = plaintext.slice(0, PREFIX_LEN);

  const rows = await db.select().from(devices).where(eq(devices.tokenPrefix, prefix));
  if (rows.length === 0) return null;

  for (const device of rows) {
    if (device.status === 'revoked') continue;
    let ok = false;
    try {
      ok = await argon2.verify(device.tokenHash, plaintext + env.DEVICE_TOKEN_PEPPER);
    } catch {
      ok = false;
    }
    if (ok) return device;
  }
  return null;
}
