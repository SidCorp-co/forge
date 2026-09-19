import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyDeviceCredential } from '../auth/device-credential.js';
import { verifyUserToken } from '../auth/jwt.js';
import { isPatLike } from '../auth/pat-format.js';
import { runWithPatScope } from '../auth/pat-scope.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { type ActorAgency, actorAgency } from '../issues/actor-agency.js';
import { readBearerToken } from './bearer.js';
import { beginPatRequest } from './pat-rest-surface.js';

export type AuthVars = {
  userId: string;
  deviceId?: string;
  principal?: 'user' | 'device' | 'pat';
  agency?: ActorAgency | null;
  agentUserId?: string;
  patTokenId?: string;
};

export function restActor(c: Context<{ Variables: RestActorVars }>): {
  type: 'user';
  id: string;
  agency: ActorAgency;
} {
  return {
    type: 'user',
    id: c.get('userId'),
    agency: actorAgency({ type: 'user', agency: restEstablishedAgency(c) }),
  };
}

type RestActorVars = {
  userId: string;
  agency?: ActorAgency | null;
  principal?: 'user' | 'device' | 'pat';
};

export function restEstablishedAgency(
  c: Context<{ Variables: RestActorVars }>,
): ActorAgency | null {
  return c.get('principal') === 'user' ? 'human' : (c.get('agency') ?? null);
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
export function requireAuth(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const token = readBearerToken(c);

    if (isPatLike(token)) {
      const { principal, scope } = await beginPatRequest(c, token);
      c.set('userId', principal.userId);
      c.set('principal', 'pat');
      c.set('agency', principal.agency);
      if (principal.agentUserId) c.set('agentUserId', principal.agentUserId);
      c.set('patTokenId', principal.tokenId);
      return runWithPatScope(scope, () => next());
    }

    try {
      const claims = await verifyUserToken(token);
      c.set('userId', claims.sub);
      c.set('principal', 'user');
    } catch {
      throw new HTTPException(401, {
        message: 'invalid token',
        cause: { code: 'INVALID_TOKEN' },
      });
    }

    await next();
  };
}

export function requireUserOrDevice(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const token = readBearerToken(c);

    if (!isPatLike(token)) {
      try {
        const claims = await verifyUserToken(token);
        c.set('userId', claims.sub);
        c.set('principal', 'user');
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
    if (!device) {
      throw new HTTPException(401, {
        message: 'invalid token',
        cause: { code: 'INVALID_TOKEN' },
      });
    }
    c.set('deviceId', device.id);
    c.set('principal', 'device');
    c.set('agency', 'agent');
    await next();
  };
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
  return async (c, next) => {
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
}
