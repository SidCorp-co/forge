import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { type InferSelectModel, and, eq, ne } from 'drizzle-orm';
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

/**
 * Auto-pair variant used by the ISS-200 sign-in flow: if a non-revoked device
 * already exists for the same (ownerId, name, platform) triple, rotate its
 * token in place rather than create a duplicate row. Avoids cluttering
 * `/me/devices` when a user signs in repeatedly from the same machine.
 *
 * Distinct from `issueDeviceToken`, which is always-insert and used by the
 * legacy project pairing flow where each redemption is intentionally a fresh
 * device row.
 */
export async function issueOrRotateDeviceToken(
  input: IssueDeviceTokenInput,
): Promise<IssuedDeviceToken> {
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenPrefix = plaintext.slice(0, PREFIX_LEN);
  const tokenHash = await argon2.hash(plaintext + env.DEVICE_TOKEN_PEPPER, ARGON2_OPTIONS);

  const [existing] = await db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.ownerId, input.ownerId),
        eq(devices.name, input.name),
        eq(devices.platform, input.platform),
        ne(devices.status, 'revoked'),
      ),
    )
    .limit(1);

  if (existing) {
    const [rotated] = await db
      .update(devices)
      .set({
        tokenHash,
        tokenPrefix,
        ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
        ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
      })
      .where(eq(devices.id, existing.id))
      .returning();
    if (!rotated) throw new Error('issueOrRotateDeviceToken: rotate returned no row');
    return { device: rotated, plaintext };
  }

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
  if (!device) throw new Error('issueOrRotateDeviceToken: insert returned no row');
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
