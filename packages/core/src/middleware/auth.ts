import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyDeviceCredential } from '../credentials/device-credential.js';
import { verifyUserToken } from '../credentials/jwt.js';
import { isPatLike } from '../credentials/pat-format.js';
import { runWithPatScope } from '../credentials/pat-scope.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { readBearerToken } from './bearer.js';
import { declareGate } from './declared-gate.js';
import { beginPatRequest } from './pat-rest-surface.js';

export type AuthVars = {
  userId: string;
  deviceId?: string;
  principal?: 'user' | 'device' | 'pat';
  /**
   * Whether the credential this request arrived on is a person's or an
   * agent's, set by every branch of every door below. A session JWT is a
   * person at a keyboard; a token bound to a paired box is that box's, so an
   * agent's; any other token carries its holder's `users.kind`.
   */
  agency?: ActorAgency;
  /** The paired box a token is bound to, which marks a write made with it as that box's. */
  patDeviceId?: string;
  agentUserId?: string;
  patTokenId?: string;
  /** The person the token acts for (`personalAccessTokens.onBehalfOf`). */
  onBehalfOf?: string;
};

/** The request's actor, with the credential it arrived on and whom that credential acts for. */
export function restActor(c: Context<{ Variables: RestActorVars }>): {
  type: 'user';
  id: string;
  agency: ActorAgency;
  tokenId: string | null;
  onBehalfOf: string | null;
} {
  return {
    type: 'user',
    id: c.get('userId'),
    agency: restAgency(c),
    tokenId: c.get('patTokenId') ?? null,
    onBehalfOf: c.get('onBehalfOf') ?? null,
  };
}

type RestActorVars = {
  userId: string;
  agency?: ActorAgency;
  principal?: 'user' | 'device' | 'pat';
  patTokenId?: string;
  onBehalfOf?: string;
};

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
  if (principal.onBehalfOf) c.set('onBehalfOf', principal.onBehalfOf);
  return runWithPatScope(scope, () => next());
}

export function requireAuth(): MiddlewareHandler<{ Variables: AuthVars }> {
  return declareGate('requireAuth', async (c, next) => {
    const token = readBearerToken(c);

    if (isPatLike(token)) return admitPat(c, token, next);

    try {
      const claims = await verifyUserToken(token);
      c.set('userId', claims.sub);
      c.set('principal', 'user');
      c.set('agency', 'human');
    } catch {
      throw new HTTPException(401, {
        message: 'invalid token',
        cause: { code: 'INVALID_TOKEN' },
      });
    }

    await next();
  });
}

export function requireUserOrDevice(): MiddlewareHandler<{ Variables: AuthVars }> {
  return declareGate('requireUserOrDevice', async (c, next) => {
    const token = readBearerToken(c);

    if (!isPatLike(token)) {
      try {
        const claims = await verifyUserToken(token);
        c.set('userId', claims.sub);
        c.set('principal', 'user');
        c.set('agency', 'human');
        await next();
        return;
      } catch {
        throw new HTTPException(401, {
          message: 'invalid token',
          cause: { code: 'INVALID_TOKEN' },
        });
      }
    }

    const device = await verifyDeviceCredential(token);
    if (!device) return admitPat(c, token, next);
    c.set('deviceId', device.id);
    c.set('principal', 'device');
    c.set('agency', 'agent');
    await next();
  });
}

/** The columns of the caller's `users` row that an auth gate decides on. */
export type AuthUserRow = { email: string; emailVerifiedAt: Date | null };

/**
 * The caller's `users` row, read straight from the database.
 *
 * For a caller with no request to memoise against: the WebSocket
 * `canSubscribe` gate reaches `isPlatformAdmin` outside any Hono context, and
 * has no `c` to hold an answer on.
 */
export async function readAuthUser(userId: string): Promise<AuthUserRow | null> {
  const [row] = await db
    .select({ email: users.email, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

const AUTH_USER_VAR = 'authUserResolution';

type AuthUserResolution = { userId: string; row: AuthUserRow | null };

export async function authUserRow(c: Context, userId: string): Promise<AuthUserRow | null> {
  const cached = c.get(AUTH_USER_VAR) as AuthUserResolution | undefined;
  if (cached && cached.userId === userId) return cached.row;

  const row = await readAuthUser(userId);
  c.set(AUTH_USER_VAR, { userId, row } satisfies AuthUserResolution);
  return row;
}

export function assertEmailVerified(): MiddlewareHandler<{ Variables: AuthVars }> {
  return declareGate('assertEmailVerified', async (c, next) => {
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
  });
}
