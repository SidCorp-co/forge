// The token one steward act is made under (REQ-48 BC-1): the project's steward account, resolved as
// a `steward` turn origin, minted fenced to the project with the steward's menu and the one approval
// it names, and revoked by the caller when the act ends.

import { randomBytes } from 'node:crypto';
import { stewardTokenName } from '../credentials/pat-format.js';
import {
  mintTurnCredential,
  STEWARD_TURN_GRANTS,
  STEWARD_TURN_MENU,
  type TurnCredential,
} from '../credentials/turn-credential.js';
import { resolveTurnAuthority } from '../permissions/index.js';

/** A gateway act's token outlives its turn and nothing more. */
export const STEWARD_TURN_TTL_MS = 10 * 60_000;

/** The steward account's token for one act, or the refusal that says why it may not act. */
export async function mintStewardCredential(args: {
  projectId: string;
  stewardId: string;
  ttlMs: number;
  /** A name the token is found by; it must start `steward ` (`pat-format.ts:stewardTokenName`). */
  name?: string;
}): Promise<TurnCredential> {
  const resolved = await resolveTurnAuthority({
    userId: args.stewardId,
    projectId: args.projectId,
    viaTokenId: null,
    origin: 'steward',
  });
  if (!resolved.ok) {
    throw new Error(
      `steward: the steward account cannot act on project ${args.projectId}: ${resolved.refusal.code}: ${resolved.refusal.message}`,
    );
  }
  return mintTurnCredential({
    authority: resolved.authority,
    menu: STEWARD_TURN_MENU,
    explicit: STEWARD_TURN_GRANTS,
    name: args.name ?? stewardTokenName(new Date(), randomBytes(4).toString('hex')),
    ttlMs: args.ttlMs,
  });
}
