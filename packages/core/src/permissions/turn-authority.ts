/**
 * Whether a turn may act as the person whose message it answers (ISS-17): the person must hold
 * `project.read` on the project, and the token they reached Forge with, when there was one, must
 * still be live and reach the project. The token a turn then acts under is minted by
 * `credentials/turn-credential.ts:mintTurnCredential`.
 */

import type { TurnAuthorityRefusalCode } from '@forge/contracts/auth';
import { PAT_GRANT_EPOCH } from '../credentials/pat-permissions.js';
import { liveTurnToken, type TurnAuthorityOutcome } from '../credentials/turn-credential.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { holds } from './can.js';

const refuse = (code: TurnAuthorityRefusalCode, message: string): TurnAuthorityOutcome => ({
  ok: false,
  refusal: { code, message },
});

/**
 * Resolve whether `userId` may be acted as on `projectId` right now, bounded by `viaTokenId`
 * when the person reached Forge with a token. Read at the moment the turn acts, not when the
 * message arrived: a role or a token that went away since is not acted on.
 */
export async function resolveTurnAuthority(args: {
  userId: string;
  projectId: string;
  viaTokenId: string | null;
}): Promise<TurnAuthorityOutcome> {
  const access = await effectiveProjectRole(args.userId, args.projectId);
  if (!(access ? holds(access, 'project.read') : false)) {
    return refuse(
      'TURN_NO_ROLE',
      'I cannot act on this: the person asking holds no role on this project, so there is nobody here I may act as. A project admin can add them.',
    );
  }

  let grant: readonly string[] | null = null;
  let fence: readonly string[] | null = null;
  let scopes: readonly string[] = ['read', 'write'];
  let grantEpoch = PAT_GRANT_EPOCH;
  if (args.viaTokenId) {
    const row = await liveTurnToken(args.viaTokenId, args.userId);
    if (!row) {
      return refuse(
        'TURN_TOKEN_NOT_LIVE',
        'I will not act on this: the access token it was sent with has been revoked or has expired since, and a message is acted on with the authority it arrived with. Send it again signed in, or with a live token.',
      );
    }
    const tokenFence = row.boundProjectId ? [row.boundProjectId] : (row.projectIds ?? null);
    if (tokenFence !== null && !tokenFence.includes(args.projectId)) {
      return refuse(
        'TURN_TOKEN_FENCED',
        'I will not act on this: the access token it was sent with does not reach this project, and acting here would reach past it.',
      );
    }
    grant = row.permissions ?? null;
    fence = tokenFence;
    scopes = row.scopes;
    grantEpoch = row.grantEpoch;
  }

  return {
    ok: true,
    authority: {
      userId: args.userId,
      projectId: args.projectId,
      viaTokenId: args.viaTokenId,
      grant,
      fence,
      scopes,
      grantEpoch,
    },
  };
}
