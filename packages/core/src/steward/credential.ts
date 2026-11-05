// The token one steward act is made under (REQ-48 BC-1): the project's steward account, resolved as
// a `steward` turn origin, minted fenced to the project with the steward's menu and only the
// approvals its acts name (`STEWARD_ACT_APPROVALS`), and revoked by the caller when the act ends.

import { randomBytes } from 'node:crypto';
import type { TurnAuthorityRefusalCode } from '@forge/contracts/auth';
import type { ProjectPermission } from '@forge/contracts/permissions';
import type { StewardAct } from '@forge/contracts/steward';
import { STEWARD_ACT_APPROVALS } from '@forge/contracts/steward-runtime';
import { stewardTokenName } from '../credentials/pat-format.js';
import {
  mintTurnCredential,
  STEWARD_TURN_MENU,
  type TurnCredential,
} from '../credentials/turn-credential.js';
import type { Tx } from '../db/client.js';
import { refuser } from '../lib/refusal.js';
import { resolveTurnAuthority } from '../permissions/index.js';

/** A gateway act's token outlives its turn and nothing more. */
export const STEWARD_TURN_TTL_MS = 10 * 60_000;

const refuseAuthority = refuser<TurnAuthorityRefusalCode>('TURN_ORIGIN_REFUSED');

/** The approvals a token for `acts` names: each act's own, and nothing another act holds. */
export function approvalsOf(acts: readonly StewardAct[]): ProjectPermission[] {
  return [...new Set(acts.flatMap((a) => STEWARD_ACT_APPROVALS[a]))];
}

/**
 * The steward account's token for `acts`, or the refusal that says why it may not act, under the
 * turn authority's own code (`turn-credential.ts:turnAuthorityRefusalOf` reads it back).
 */
export async function mintStewardCredential(args: {
  projectId: string;
  stewardId: string;
  acts: readonly StewardAct[];
  ttlMs: number;
  /** A name the token is found by; it must start `steward ` (`pat-format.ts:stewardTokenName`). */
  name?: string;
  /** The transaction the token is inserted in, where the caller supersedes an earlier one of its name. */
  tx?: Tx;
}): Promise<TurnCredential> {
  const resolved = await resolveTurnAuthority({
    userId: args.stewardId,
    projectId: args.projectId,
    viaTokenId: null,
    origin: 'steward',
  });
  if (!resolved.ok) {
    throw refuseAuthority(
      resolved.refusal.code,
      `the steward account cannot act on project ${args.projectId}: ${resolved.refusal.message}`,
    );
  }
  return mintTurnCredential({
    authority: resolved.authority,
    menu: STEWARD_TURN_MENU,
    explicit: approvalsOf(args.acts),
    name: args.name ?? stewardTokenName(new Date(), randomBytes(4).toString('hex')),
    ttlMs: args.ttlMs,
    tx: args.tx,
  });
}
