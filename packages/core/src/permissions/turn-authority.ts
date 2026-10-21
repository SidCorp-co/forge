/**
 * Whether a turn may act as the person whose message it answers (ISS-17): the person must hold
 * `project.read` on the project, and the token they reached Forge with, when there was one, must
 * still be live and reach the project. A steward turn (REQ-48) acts as the project's own steward
 * account and no other. The token a turn then acts under is minted by
 * `credentials/turn-credential.ts:mintTurnCredential`.
 */

import type { TurnAuthorityRefusalCode } from '@forge/contracts/auth';
import { and, eq } from 'drizzle-orm';
import { PAT_GRANT_EPOCH, patGrantIsStated } from '../credentials/pat-permissions.js';
import {
  liveTurnToken,
  type TurnAuthorityOutcome,
  type TurnOrigin,
} from '../credentials/turn-credential.js';
import { db } from '../db/client.js';
import { stewardAccounts } from '../db/schema-steward-runs.js';
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
  /** `steward`: the turn acts as `userId` only where it is this project's steward account. */
  origin?: TurnOrigin;
}): Promise<TurnAuthorityOutcome> {
  if (args.origin === 'steward' && !(await isProjectSteward(args.userId, args.projectId))) {
    return refuse(
      'TURN_ORIGIN_REFUSED',
      `I will not act on this: a steward turn acts only as this project's steward account, and ${args.userId} is not it.`,
    );
  }
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
    if (!patGrantIsStated(row.permissions)) {
      return refuse(
        'TURN_TOKEN_GRANT_UNSTATED',
        'I will not act on this: the access token it was sent with was minted before a token stated what it may reach, so it reaches nothing. Revoke it under Settings → API Tokens and send it again signed in, or with a token naming what it may reach.',
      );
    }
    grant = row.permissions;
    fence = tokenFence;
    scopes = row.scopes;
    grantEpoch = row.grantEpoch;
  }

  return {
    ok: true,
    authority: {
      userId: args.userId,
      projectId: args.projectId,
      origin: args.origin ?? 'message',
      viaTokenId: args.viaTokenId,
      grant,
      fence,
      scopes,
      grantEpoch,
    },
  };
}

async function isProjectSteward(userId: string, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: stewardAccounts.userId })
    .from(stewardAccounts)
    .where(and(eq(stewardAccounts.projectId, projectId), eq(stewardAccounts.userId, userId)))
    .limit(1);
  return row !== undefined;
}
