/**
 * What the unreadable-credential suites share (ISS-1259): a connection and a binding of it whose
 * stored secrets are sealed under a key this process does not hold, which is what a rotated or
 * misconfigured INTEGRATION_MASTER_KEY leaves behind, and the two things every refusal is read for.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { TestDb } from './db.js';

export const WEBHOOK_SECRET = 'the-binding-signing-secret-at-least-32-chars';
const PLANTED_TOKEN = 'made-up-token-never-to-be-shown-0001';

export function sealedUnderAnotherKey(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export type PlantedProvider =
  | 'postman'
  | 'rocketchat'
  | 'github'
  | 'coolify'
  | 'google'
  | 'epodsystem';

export interface PlantOptions {
  config?: Record<string, unknown>;
  bindingConfig?: Record<string, unknown>;
  role?: 'service' | 'deploy';
  agentAccess?: 'none' | 'all';
}

export interface Planted {
  connectionId: string;
  bindingId: string;
  sealed: Buffer;
}

/** A connection of `owner.userId` and one binding of it on `owner.projectId`, unreadable here. */
export async function plantUnreadable(
  db: TestDb,
  owner: { userId: string; projectId: string },
  provider: PlantedProvider,
  opts: PlantOptions = {},
): Promise<Planted> {
  const store = await import('../../src/integrations/store.js');
  const connection = await store.createConnection({
    ownerType: 'user',
    ownerId: owner.userId,
    provider,
    displayName: `Planted ${provider}`,
    config: opts.config ?? {},
  });
  const sealed = sealedUnderAnotherKey(JSON.stringify({ apiKey: PLANTED_TOKEN }));
  await db.execute(
    sql`UPDATE integration_connections SET secrets_enc = ${sealed} WHERE id = ${connection.id}`,
  );
  const binding = await store.createBinding({
    connectionId: connection.id,
    projectId: owner.projectId,
    provider,
    role: opts.role ?? 'service',
    stages: opts.role === 'deploy' ? ['live'] : [],
    integrationSecret: WEBHOOK_SECRET,
    ...(opts.bindingConfig ? { config: opts.bindingConfig } : {}),
    ...(opts.agentAccess ? { agentAccess: opts.agentAccess } : {}),
  });
  return { connectionId: connection.id, bindingId: binding.id, sealed };
}

/** Nothing a secret could be recovered from: not the sealed bytes, the key, or the plaintext. */
export function expectNothingSecret(text: string, sealed: Buffer): void {
  expect(text).not.toContain(PLANTED_TOKEN);
  expect(text).not.toContain(sealed.toString('hex'));
  expect(text).not.toContain(sealed.toString('base64'));
  expect(text).not.toContain(process.env.INTEGRATION_MASTER_KEY as string);
  expect(text).not.toMatch(/Unsupported state|unable to authenticate/);
}

export function expectNamed(message: string | undefined, label: string, ids: string[]): void {
  expect(message).toContain(`The stored credential of the ${label} connection`);
  for (const id of ids) expect(message).toContain(id);
  expect(message).toContain('could not be decrypted with the key this server holds');
}
