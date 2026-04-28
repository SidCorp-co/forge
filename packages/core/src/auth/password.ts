import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

/**
 * Lazily computed argon2id hash of a random secret, reused across all
 * unknown-email login attempts. Used to equalize verify() timing with the
 * wrong-password path (prevents user enumeration via response latency).
 *
 * The plaintext is generated once per process and discarded — only the hash
 * (and the cost of verifying against it) matters.
 */
let dummyHashPromise: Promise<string> | null = null;
export function getDummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash(randomBytes(32).toString('hex'), OPTIONS);
  }
  return dummyHashPromise;
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
