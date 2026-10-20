import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyDeviceCredential } from '../auth/device-credential.js';
import { verifyUserToken } from '../auth/jwt.js';
import { isPatLike } from '../auth/pat-format.js';
import { runWithPatScope } from '../auth/pat-scope.js';
import type { IssueCreationChannel } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { readBearerToken } from './bearer.js';
import { refuses } from './declarations.js';
import { beginPatRequest } from './pat-rest-surface.js';
import { admitSessionUser, authUserRow } from './session-account.js';

export type AuthVars = {
  userId: string;
  deviceId?: string;
  principal?: 'user' | 'device' | 'pat';
  /**
   * Whether the credential this request arrived on belongs to a person or to
   * an agent, set by every branch of every door below (ISS-1137). A session
   * JWT is a person at a keyboard; a token carries its owner's `users.kind`; a
   * device is a machine.
   */
  agency?: ActorAgency;
  agentUserId?: string;
  patTokenId?: string;
  patDeviceId?: string;
};

export function restActor(c: Context<{ Variables: RestActorVars }>): {
  type: 'user';
  id: string;
  agency: ActorAgency;
} {
  return { type: 'user', id: c.get('userId'), agency: restAgency(c) };
}

type RestActorVars = {
  userId: string;
  agency?: ActorAgency;
  principal?: 'user' | 'device' | 'pat';
  patTokenId?: string;
  patDeviceId?: string;
};

export type RestCredential = {
  via: Extract<IssueCreationChannel, 'web' | 'pat' | 'device'>;
  tokenId: string | null;
};

/**
 * The credential this request came through: `web` for a session JWT, `pat` for a token, `device`
 * for a token bound to a paired device. An absent principal, or a token with no id, is refused by
 * name like {@link restAgency}, never defaulted to `web`.
 */
export function restCredential(c: Context<{ Variables: RestActorVars }>): RestCredential {
  const principal = c.get('principal');
  if (principal === 'user') return { via: 'web', tokenId: null };
  if (principal === 'pat' || principal === 'device') {
    const tokenId = c.get('patTokenId') ?? null;
    if (principal === 'pat' && tokenId === null) {
      throw new Error(
        'restCredential: a token request carries no token id — the gate admitted a personal access ' +
          'token without recording which one, so the credential cannot be named.',
      );
    }
    const device = principal === 'device' || c.get('patDeviceId') !== undefined;
    return { via: device ? 'device' : 'pat', tokenId };
  }
  throw new Error(
    'restCredential: no principal on this request — the route was reached without requireAuth(), ' +
      'requireUserOrDevice() or requireAnyAuth(), and which credential it came through cannot be ' +
      'answered from the request alone. Mount one of those gates on it.',
  );
}

/**
 * The agency the door established for this request.
 *
 * Every branch of every gate in this file and in `require-any-auth.ts` sets it,
 * so an absent value is a route reached through no gate at all rather than a
 * caller whose kind could not be worked out — and it is refused by name rather
 * than guessed, because a guess here is what wrote every person's issue as an
 * agent's until ISS-1137.
 */
function restAgency(c: Context<{ Variables: RestActorVars }>): ActorAgency {
  const agency = c.get('agency');
  if (!agency) {
    throw new Error(
      'restActor: no agency on this request — the route was reached without requireAuth(), ' +
        'requireUserOrDevice() or requireAnyAuth(), and who is writing cannot be answered from ' +
        'the request alone. Mount one of those gates on it.',
    );
  }
  return agency;
}

export function restAuthored(c: Context<{ Variables: RestActorVars }>): 'human' | 'agent' {
  return restActor(c).agency;
}

/**
 * The REST data plane's gate: a user JWT (web/desktop) or a Personal Access
 * Token (the `forge-runner api` CLI, and any agent holding one).
 *
 * A PAT resolves to its owner's `userId`, which on its own would widen a
 * project-scoped token into an account-scoped one. {@link beginPatRequest} is
 * what stops that, and `requireAnyAuth` calls the same function.
 */
async function admitPat(
  c: Context<{ Variables: AuthVars }>,
  token: string,
  next: () => Promise<void>,
): Promise<void> {
  const { principal, scope } = await beginPatRequest(c, token);
  c.set('userId', principal.userId);
  c.set('principal', 'pat');
  c.set('agency', principal.agency);
  if (principal.agentUserId) c.set('agentUserId', principal.agentUserId);
  c.set('patTokenId', principal.tokenId);
  if (principal.deviceId) c.set('patDeviceId', principal.deviceId);
  return runWithPatScope(scope, () => next());
}

export function requireAuth(): MiddlewareHandler<{ Variables: AuthVars }> {
  const gate: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
    const token = readBearerToken(c);

    if (isPatLike(token)) return admitPat(c, token, next);

    let subject: string;
    try {
      subject = (await verifyUserToken(token)).sub;
    } catch {
      throw new HTTPException(401, {
        message: 'invalid token',
        cause: { code: 'INVALID_TOKEN' },
      });
    }
    await admitSessionUser(c, subject);
    c.set('userId', subject);
    c.set('principal', 'user');
    c.set('agency', 'human');

    await next();
  };
  return refuses(gate, [
    { status: 401, code: 'UNAUTHENTICATED', when: 'no bearer token and no session cookie' },
    {
      status: 401,
      code: 'INVALID_TOKEN',
      when: 'the session token or personal access token does not verify',
    },
    {
      status: 403,
      code: 'AGENT_CANNOT_LOGIN',
      when: 'the session token names an agent account, which holds no session',
    },
  ]);
}

export function requireUserOrDevice(): MiddlewareHandler<{ Variables: AuthVars }> {
  const gate: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
    const token = readBearerToken(c);

    if (!isPatLike(token)) {
      let subject: string;
      try {
        subject = (await verifyUserToken(token)).sub;
      } catch {
        throw new HTTPException(401, {
          message: 'invalid token',
          cause: { code: 'INVALID_TOKEN' },
        });
      }
      await admitSessionUser(c, subject);
      c.set('userId', subject);
      c.set('principal', 'user');
      c.set('agency', 'human');
      await next();
      return;
    }

    const device = await verifyDeviceCredential(token);
    if (!device) return admitPat(c, token, next);
    c.set('deviceId', device.id);
    c.set('principal', 'device');
    c.set('agency', 'agent');
    await next();
  };
  return refuses(gate, [
    { status: 401, code: 'UNAUTHENTICATED', when: 'no bearer token and no session cookie' },
    {
      status: 401,
      code: 'INVALID_TOKEN',
      when: 'the session token or personal access token does not verify',
    },
    {
      status: 403,
      code: 'AGENT_CANNOT_LOGIN',
      when: 'the session token names an agent account, which holds no session',
    },
  ]);
}

export { type AuthUserRow, authUserRow, readAuthUser } from './session-account.js';

export function assertEmailVerified(): MiddlewareHandler<{ Variables: AuthVars }> {
  const gate: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
    if (c.get('principal') === 'device') {
      await next();
      return;
    }
    const row = await authUserRow(c, c.get('userId'));

    if (!row || row.emailVerifiedAt === null) {
      throw new HTTPException(403, {
        message: 'verify email',
        cause: { code: 'EMAIL_NOT_VERIFIED' },
      });
    }

    await next();
  };
  return refuses(gate, [
    {
      status: 403,
      code: 'EMAIL_NOT_VERIFIED',
      when: 'the account has not verified its email address',
    },
  ]);
}
