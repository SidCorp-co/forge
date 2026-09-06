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

// cm:guard the machine-token name prefixes are LOAD-BEARING, and they live here for the same reason `forge_pat_` does: three modules decide real behaviour on them and none of them may spell one itself. They are how `countActivePatsForUser` keeps a fleet's machine tokens off the owner's cap, how a dispatch's revoke finds the row without storing a job or session id on the PAT table, and — since the name is the only column separating an agent's credential from a person's — how `authenticatePat` decides `agency`, which is what the ISS-786/812 evidence gates read. A fourth copy of a literal is how one of those three goes quietly wrong.
// cm:guard ADDING a species to this family means adding it to `MACHINE_TOKEN_NAME_PREFIXES`, and nothing else. Every one of the three consumers reads the family, never a member: that is the whole reason `session:` (ISS-927) cost one line here instead of three edits that could each have been forgotten. A prefix that is minted but left out of this array is a machine credential the cap counts, the revoke sweep misses and `authenticatePat` stamps `human` — which is the exact bypass ISS-894 paid to patch.
const JOB_TOKEN_NAME_PREFIX = 'job:';
const SESSION_TOKEN_NAME_PREFIX = 'session:';

/** Every name prefix that marks a token as machine-minted rather than a person's. */
export const MACHINE_TOKEN_NAME_PREFIXES = [
  JOB_TOKEN_NAME_PREFIX,
  SESSION_TOKEN_NAME_PREFIX,
] as const;

/** SQL `LIKE` patterns matching every machine-minted token name. */
export const machineTokenNameLikes = MACHINE_TOKEN_NAME_PREFIXES.map((p) => `${p}%`);

/** SQL `LIKE` pattern matching every job-minted token name. */
export const jobTokenNameLike = `${JOB_TOKEN_NAME_PREFIX}%`;

export const jobTokenNameFor = (jobId: string) => `${JOB_TOKEN_NAME_PREFIX}${jobId}`;

export const sessionTokenNameFor = (sessionId: string) =>
  `${SESSION_TOKEN_NAME_PREFIX}${sessionId}`;

export const isJobTokenName = (name: string | null | undefined): boolean =>
  typeof name === 'string' && name.startsWith(JOB_TOKEN_NAME_PREFIX);

export const isSessionTokenName = (name: string | null | undefined): boolean =>
  typeof name === 'string' && name.startsWith(SESSION_TOKEN_NAME_PREFIX);

/**
 * True for any token a machine minted for itself — a dispatched job or an
 * unattended agent session. This, not `isJobTokenName`, is what the PAT cap,
 * the hand-mint refusal and the `agency` stamp read.
 */
export const isMachineTokenName = (name: string | null | undefined): boolean =>
  typeof name === 'string' && MACHINE_TOKEN_NAME_PREFIXES.some((p) => name.startsWith(p));

/** What a machine token names: the job it was minted for, or the session. */
export type MachineTokenRef = { kind: 'job'; id: string } | { kind: 'session'; id: string };

/**
 * The id a machine token carries in its own name, for the callers that need
 * the pipeline context rather than only the fact that one exists.
 */
// cm:guard the fourth consumer of these prefixes, and it lives HERE for the same reason the other three do — it is the ONE that has to tell `job:` from `session:`, so a caller that spelled either literal itself would be the copy the guard above forbids. `resolveActiveJobContext` used to take a `devices.id` and answer "whatever that box is running"; a machine token names its own job, which is exact, and this is where that name is read.
export function parseMachineTokenName(name: string | null | undefined): MachineTokenRef | null {
  if (typeof name !== 'string') return null;
  if (name.startsWith(JOB_TOKEN_NAME_PREFIX)) {
    const id = name.slice(JOB_TOKEN_NAME_PREFIX.length);
    return id ? { kind: 'job', id } : null;
  }
  if (name.startsWith(SESSION_TOKEN_NAME_PREFIX)) {
    const id = name.slice(SESSION_TOKEN_NAME_PREFIX.length);
    return id ? { kind: 'session', id } : null;
  }
  return null;
}
