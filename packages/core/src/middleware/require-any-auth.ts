import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyUserToken } from '../auth/jwt.js';
import { isPatLike } from '../auth/pat-format.js';
import { runWithPatScope } from '../auth/pat-scope.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { readBearerToken } from './bearer.js';
import { declareGate } from './declared-gate.js';
import { beginPatRequest } from './pat-rest-surface.js';

export type AnyAuthVars = {
  userId: string;
  agency?: ActorAgency;
  principal?: 'user' | 'device' | 'pat';
  patDeviceId?: string;
};

const unauth = (message: string) =>
  new HTTPException(401, { message, cause: { code: 'UNAUTHENTICATED' } });

export function requireAnyAuth(): MiddlewareHandler<{ Variables: AnyAuthVars }> {
  return declareGate('requireAnyAuth', async (c, next) => {
    const token = readBearerToken(c);

    if (isPatLike(token)) {
      const { principal, scope } = await beginPatRequest(c, token);
      c.set('userId', principal.userId);
      c.set('principal', 'pat');
      c.set('agency', principal.agency);
      if (principal.deviceId) c.set('patDeviceId', principal.deviceId);
      return runWithPatScope(scope, () => next());
    }

    let claims: Awaited<ReturnType<typeof verifyUserToken>>;
    try {
      claims = await verifyUserToken(token);
    } catch {
      throw unauth('invalid token');
    }
    c.set('userId', claims.sub);
    c.set('principal', 'user');
    c.set('agency', 'human');
    await next();
  });
}
