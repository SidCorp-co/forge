import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyDeviceCredential } from '../auth/device-credential.js';
import { verifyUserToken } from '../auth/jwt.js';
import { isPatLike } from '../auth/pat-format.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { type ActorAgency, actorAgency } from '../issues/actor-agency.js';
import { readBearerToken } from './bearer.js';
import { beginPatRequest, withPatScope } from './pat-rest-surface.js';

export type AuthVars = {
  userId: string;
  /** Set once `assertEmailVerified` has read the row for this request, so a later mount does not read it again. */
  emailVerified?: true;
  // cm:guard set ONLY for a device principal, and `userId` is left unset beside it on purpose — every handler authorizing through `loadProjectAccess(projectId, userId)` then fails closed for a device unless it honours the device principal by name (`requireUserOrDevice`).
  deviceId?: string;
  principal?: 'user' | 'device' | 'pat';
  // cm:guard REST must carry this or the whole agency axis stops at the door: `requireAuth` reduces a rich principal to `principal:'pat'`, a string tag, and every route downstream then hardcodes a `user` actor. That is how an agent holding a PAT reached `PATCH /api/issues/batch` — which DOES transition, via transitionIssueStatus — and skipped the ISS-786/812 gates while `/mcp` enforced them, because MCP synthesizes a device for a PAT and REST has none to synthesize.
  agency?: ActorAgency | null;
  /**
   * The agent account whose own credential this request carries, or unset.
   *
   * The established identity, as distinct from {@link AuthVars.agency}'s trust
   * axis: this says WHICH agent, and it is set only where the token's owner is
   * an agent account (ISS-1003).
   */
  // cm:guard never fall back to `userId` when this is unset. A person's token carries their id and names no agent, and reading it as one is precisely the borrowed authority the field exists to tell apart — the same fiction `deviceId` already refuses on the box axis.
  agentUserId?: string;
  patTokenId?: string;
};

/**
 * The actor for a REST write, carrying the trust axis the routes must not
 * decide for themselves.
 */
// cm:guard build the actor HERE, never as a `{ type: 'user' as const }` literal in a route — three route files each had their own copy and all three were wrong in the same way, which is what a second copy of an auth decision always costs. `id` stays the owning user (a job's write really is its creator's); `agency` is what the lifecycle gates read, through `actorAgency` and never by hand.
// cm:guard a SESSION is the only thing that establishes a person, and that is the whole reason this reads `principal` before it reads `agency`. Everything else carries what its credential established: `agent` for an agent's own token, `null` — unestablished — for a person's, and `agent` for a device. This function used to answer `agency ?? 'human'`, which turned the unestablished case into a claim that a person was typing; `restAuthored` sat four lines below computing the same question correctly, and two functions in one file disagreeing about who is speaking is what ISS-1003 deleted (measured 2026-09-13 on ISS-978).
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

/**
 * What this request's CREDENTIAL established about who is speaking, or `null`
 * where it established nothing (ISS-1003).
 *
 * A session establishes a person. An agent's own token establishes that agent.
 * A person's token establishes neither: it may act, but it may not claim an
 * identity, and most agents are running on one.
 */
// cm:guard the ONLY caller that may read this instead of {@link restActor} is one STORING a claim about who wrote something — `comments.author_agency` and nothing else so far. A gate reads `restActor`, which resolves the null to `agent` and fails closed; a gate reading this and coalescing it itself is a second resolution with its own direction, which is how the two start disagreeing. The whole reason the field is separate is that `human` here was wrong for the majority of agents, and a wrong claim is worse than no claim.
export function restEstablishedAgency(
  c: Context<{ Variables: RestActorVars }>,
): ActorAgency | null {
  return c.get('principal') === 'user' ? 'human' : (c.get('agency') ?? null);
}

/**
 * Whether a person is at the keyboard on THIS request, as the hook bus asks it.
 */
// cm:guard one derivation, not two: this is `restActor(c).agency` and nothing else, so the answer the hook bus gets and the answer the lifecycle gates get cannot drift apart. It reads `agent` for an unestablished caller because `restActor` fails closed there, which is the same verdict the old standalone spelling reached by testing the session — and now it reaches it for the stated reason rather than by coincidence (ISS-1003).
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
      return withPatScope(scope, () => next());
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

// cm:guard FOUR middlewares verify a device token and NONE of them hands the device its owner's account authority — `requireAnyAuth` did until ISS-927 by setting `userId = device.ownerId`, and that was the single place a credential silently became a person. `requireAuth` rejects devices outright; `requireUserOrDevice` and `requireDevice` make the device its own principal with `userId` left unset so `loadProjectAccess` fails closed. `/mcp` is no longer on this list at all: `requirePat` takes one species (ISS-931). Choosing a middleware for a new route still chooses the caller's authority, so say which you mean.
/**
 * Accept EITHER a user JWT (web/desktop) OR a device token (a CLI runner).
 *
 * Mirrors the split the `jobs` domain already has (user routes vs device-auth
 * sibling routers): the agent-sessions chat write-back (`PATCH /:id`) is hit by
 * both the desktop (user JWT) and a CLI runner (device token), on the SAME
 * path, so a single dual-auth gate is needed. User token is tried first (the
 * common case); a device token sets `deviceId`/`principal='device'` and leaves
 * `userId` unset — every route that authorizes via `loadProjectAccess(_, userId)`
 * therefore fails closed for a device unless it explicitly honors the device
 * principal (only the chat write-back does, scoped to its own session).
 */
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

    // cm:guard the PAT branch resolves a DEVICE and sets no `userId`, and it must not gain one. A `forge_pat_*` reaching here is a box's credential; giving it its holder's `userId` is precisely the `requireAnyAuth` branch ISS-927 deleted, where a machine silently became a person. A token with no `device_id` is refused rather than accepted as its owner (ISS-932).
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

export function assertEmailVerified(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    // cm:guard a device principal is exempt and cannot be otherwise: `userId` is deliberately left unset for one (see the guard on `requireUserOrDevice`), so the lookup below would find no row and refuse every paired box as unverified. The device token is the gate that stands in for the mailbox.
    if (c.get('principal') === 'device') {
      await next();
      return;
    }
    // cm:guard memoised on the request context because this middleware is mounted 134 times and a request crosses several of those routers: measured 2026-09-15, one `GET /api/projects/:id/issues?limit=1` read `email_verified_at` EIGHT times — 3.2s of a 7.6s request over a remote link, and eight round trips for one fact on a local one. A refusal is never cached: only a pass sets the flag, so a later mount still refuses what the first would have (ISS-1009).
    if (c.get('emailVerified')) {
      await next();
      return;
    }
    const userId = c.get('userId');
    const [row] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row || row.emailVerifiedAt === null) {
      throw new HTTPException(403, {
        message: 'verify email',
        cause: { code: 'EMAIL_NOT_VERIFIED' },
      });
    }
    c.set('emailVerified', true);

    await next();
  };
}
