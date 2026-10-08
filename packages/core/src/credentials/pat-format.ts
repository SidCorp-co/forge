import { randomBytes } from 'node:crypto';

const PAT_ENVS = ['dev', 'stg', 'prd'] as const;
type PatEnv = (typeof PAT_ENVS)[number];

/** Anchored — full match for token validation. */
const PAT_PATTERN = /^forge_pat_(dev|stg|prd)_[A-Fa-f0-9]{64}$/;

/** Loose prefix detector — used by the auth dispatcher to choose the PAT path. */
const PAT_PREFIX_PATTERN = /^forge_pat_(dev|stg|prd)_/;

export const PAT_PREFIX_LEN = 18;
const PAT_BODY_BYTES = 32;

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

const DEVICE_TOKEN_NAME_PREFIX = 'device:';

export const deviceTokenNameFor = (deviceId: string) => `${DEVICE_TOKEN_NAME_PREFIX}${deviceId}`;

const WORKSPACE_TOKEN_NAME_PREFIX = 'workspace:';

/**
 * The credential a box writes into one provisioned checkout's `.mcp.json`, so
 * a person opening `claude` there reaches this project. Distinct from the
 * device credential (`device:<id>`): that one names the machine and is fenced
 * to nothing for a human holder, which is why it cannot serve this.
 */
export const workspaceTokenNameFor = (deviceId: string, projectId: string) =>
  `${WORKSPACE_TOKEN_NAME_PREFIX}${deviceId}:${projectId}`;

const TURN_TOKEN_NAME_PREFIX = 'turn:';

/**
 * The token a session on a paired box answers one person's message under
 * (`agent-sessions/session-credential.ts`), found by this name to be revoked when the session ends.
 */
export const turnTokenNameFor = (sessionId: string) => `${TURN_TOKEN_NAME_PREFIX}${sessionId}`;

const TURN_DEFAULT_NAME_PREFIX = 'turn ';

export const turnTokenDefaultName = (at: Date, nonce: string) =>
  `${TURN_DEFAULT_NAME_PREFIX}${at.toISOString()} ${nonce}`;

const AGREEMENT_NAME_PREFIX = 'chat agreement ';

/**
 * The token one agreed chat proposal is written under, as the person who agreed
 * (`assistant/agreement/execute.ts`): minted for that proposal alone and revoked once it is written.
 */
export const agreementTokenNameFor = (proposalId: string) =>
  `${AGREEMENT_NAME_PREFIX}${proposalId}`;

export const isTurnTokenName = (name: string) =>
  name.startsWith(TURN_TOKEN_NAME_PREFIX) ||
  name.startsWith(TURN_DEFAULT_NAME_PREFIX) ||
  name.startsWith(AGREEMENT_NAME_PREFIX);

export type TurnTokenOrigin =
  | { door: 'assistant-turn' }
  | { door: 'box-session'; sessionId: string }
  | { door: 'agreement'; proposalId: string };

/**
 * Which chat door minted a turn token: an in-process assistant turn (`turn <at> <nonce>`), a
 * session on a paired box (`turn:<sessionId>`), the write of one agreed proposal
 * (`chat agreement <proposalId>`), or none for any other token.
 */
export function turnTokenOrigin(name: string): TurnTokenOrigin | null {
  if (name.startsWith(AGREEMENT_NAME_PREFIX)) {
    return { door: 'agreement', proposalId: name.slice(AGREEMENT_NAME_PREFIX.length) };
  }
  if (name.startsWith(TURN_DEFAULT_NAME_PREFIX)) return { door: 'assistant-turn' };
  if (name.startsWith(TURN_TOKEN_NAME_PREFIX)) {
    return { door: 'box-session', sessionId: name.slice(TURN_TOKEN_NAME_PREFIX.length) };
  }
  return null;
}

const CORE_NAME_PREFIXES = [
  DEVICE_TOKEN_NAME_PREFIX,
  WORKSPACE_TOKEN_NAME_PREFIX,
  TURN_TOKEN_NAME_PREFIX,
  TURN_DEFAULT_NAME_PREFIX,
  AGREEMENT_NAME_PREFIX,
];

// a person's token named like a turn token would make their CLI writes read as written through the assistant
export const coreTokenNamePrefixOf = (name: string): string | null =>
  CORE_NAME_PREFIXES.find((p) => name.startsWith(p)) ?? null;
