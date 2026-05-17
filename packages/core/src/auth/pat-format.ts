/**
 * Single source of truth for PAT plaintext format (ISS-150).
 *
 * Shape: `forge_pat_<env>_<64 hex chars>` where <env> ∈ dev|stg|prd.
 * The 18-char prefix `forge_pat_<env>_<4 hex>` is stored in
 * `personal_access_tokens.token_prefix` and used as the lookup key.
 *
 * The regex is exported so the Sentry scrubber and middleware dispatcher
 * use the exact same recognition. Do NOT inline the literal `forge_pat_`
 * elsewhere — import this module.
 */

import { randomBytes } from 'node:crypto';

export const PAT_ENVS = ['dev', 'stg', 'prd'] as const;
export type PatEnv = (typeof PAT_ENVS)[number];

/** Anchored — full match for token validation. */
export const PAT_PATTERN = /^forge_pat_(dev|stg|prd)_[A-Fa-f0-9]{64}$/;

/** Unanchored, global — for redaction inside larger strings (Sentry scrubber). */
export const PAT_STRING_PATTERN = /forge_pat_(?:dev|stg|prd)_[A-Fa-f0-9]+/g;

/** Loose prefix detector — used by the auth dispatcher to choose the PAT path. */
export const PAT_PREFIX_PATTERN = /^forge_pat_(dev|stg|prd)_/;

export const PAT_PREFIX_LEN = 18;
export const PAT_BODY_HEX = 64;
export const PAT_BODY_BYTES = 32;

export function patEnvForNodeEnv(nodeEnv: string): PatEnv {
  if (nodeEnv === 'production') return 'prd';
  if (nodeEnv === 'staging') return 'stg';
  return 'dev';
}

export function generatePatPlaintext(tag: PatEnv): string {
  const body = randomBytes(PAT_BODY_BYTES).toString('hex');
  return `forge_pat_${tag}_${body}`;
}

export function isPatLike(token: string): boolean {
  return PAT_PREFIX_PATTERN.test(token);
}

export function isPatValid(token: string): boolean {
  return PAT_PATTERN.test(token);
}

export function patPrefixOf(token: string): string {
  return token.slice(0, PAT_PREFIX_LEN);
}
