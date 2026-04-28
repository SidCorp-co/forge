import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REFRESH_TOKEN_PREFIX_LEN = 8;
const RAW_TOKEN_BYTES = 32;

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function generateRefreshToken(): { raw: string; prefix: string } {
  const raw = randomBytes(RAW_TOKEN_BYTES).toString('base64url');
  return { raw, prefix: raw.slice(0, REFRESH_TOKEN_PREFIX_LEN) };
}

export function hashRefreshToken(raw: string): Promise<string> {
  return argon2.hash(raw, ARGON2_OPTIONS);
}

export async function verifyRefreshToken(hash: string, raw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, raw);
  } catch {
    return false;
  }
}

export function refreshTokenExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
}

export function refreshTokenPrefix(raw: string): string {
  return raw.slice(0, REFRESH_TOKEN_PREFIX_LEN);
}
