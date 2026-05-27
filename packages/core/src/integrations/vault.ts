import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { logger } from '../logger.js';

// Read the master key from process.env directly (not via config/env.ts) so
// importing this module does not transitively force EnvSchema parsing during
// test runs that mock the DB but never touch the vault. The boot-time guard
// below catches missing keys when real integrations exist.
function readMasterKey(): string | undefined {
  const v = process.env.INTEGRATION_MASTER_KEY;
  return v && v.length > 0 ? v : undefined;
}

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function decodeKey(raw: string): Buffer {
  // Accept hex (64 char) or base64. Pad-stripped base64 is also OK because
  // Buffer.from('base64') tolerates it.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    const buf = Buffer.from(raw, 'hex');
    if (buf.length !== KEY_LEN) {
      throw new Error('INTEGRATION_MASTER_KEY: hex must decode to 32 bytes');
    }
    return buf;
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `INTEGRATION_MASTER_KEY: base64 must decode to 32 bytes (got ${buf.length})`,
    );
  }
  return buf;
}

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = readMasterKey();
  if (!raw) {
    throw new Error(
      'INTEGRATION_MASTER_KEY is not set — cannot encrypt/decrypt integration secrets. ' +
        'Generate one with: openssl rand -base64 32',
    );
  }
  cachedKey = decodeKey(raw);
  return cachedKey;
}

/**
 * True iff `INTEGRATION_MASTER_KEY` is present in the environment. Pure check
 * — does not call `getKey()` and never throws. Use from request handlers to
 * convert the missing-key boot bypass into a structured 503 before invoking
 * any encrypt/decrypt routine.
 */
export function isVaultConfigured(): boolean {
  return readMasterKey() !== undefined;
}

/** Encrypts a UTF-8 string to <iv:12><tag:16><ciphertext>. */
export function encryptSecret(plain: string): Buffer {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/** Decrypts a buffer in the <iv:12><tag:16><ciphertext> format. */
export function decryptSecret(enc: Buffer): string {
  if (!Buffer.isBuffer(enc) || enc.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('decryptSecret: ciphertext too short');
  }
  const key = getKey();
  const iv = enc.subarray(0, IV_LEN);
  const tag = enc.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = enc.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return out.toString('utf8');
}

/** Encrypts an arbitrary JSON-serializable object. */
export function encryptJson(obj: unknown): Buffer {
  return encryptSecret(JSON.stringify(obj));
}

export function decryptJson<T = unknown>(enc: Buffer): T {
  return JSON.parse(decryptSecret(enc)) as T;
}

/**
 * Boot-time guard. Throws if the master key is missing AND at least one
 * active project_integrations row exists. Fresh installs without any
 * integration stay bootable so OSS users can run core without minting a key.
 */
export async function assertVaultBootSafety(): Promise<void> {
  const raw = readMasterKey();
  if (raw) {
    // Eagerly decode so we fail fast on malformed keys at boot rather than
    // on the first encryption call.
    try {
      decodeKey(raw);
    } catch (err) {
      throw new Error(`INTEGRATION_MASTER_KEY decode failed: ${(err as Error).message}`);
    }
    return;
  }
  // Lazy-import db + schema so this module is safe to import in unit tests
  // that mock the database and never exercise the boot-time guard.
  const [{ db }, { projectIntegrations }, drizzle] = await Promise.all([
    import('../db/client.js'),
    import('../db/schema.js'),
    import('drizzle-orm'),
  ]);
  const [row] = await db
    .select({ n: drizzle.count() })
    .from(projectIntegrations)
    .where(drizzle.eq(projectIntegrations.active, true));
  if (row && Number(row.n) > 0) {
    throw new Error(
      'INTEGRATION_MASTER_KEY is not set but project_integrations contains active rows. ' +
        'Refusing to boot — secrets cannot be decrypted. Set INTEGRATION_MASTER_KEY or ' +
        'mark the affected rows inactive.',
    );
  }
  logger.warn(
    'vault: INTEGRATION_MASTER_KEY not set; encryption disabled until first active integration is created',
  );
}

export const __testing = { decodeKey };
