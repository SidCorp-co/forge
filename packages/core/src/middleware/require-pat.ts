/**
 * The `/mcp` credential (ISS-150, narrowed to one species by ISS-931).
 *
 * Accepts `Authorization: Bearer <token>` for a Personal Access Token
 * (`forge_pat_*`) and nothing else. Sets `c.get('principal')` to the resolved
 * {@link McpPrincipal} for downstream tool handlers, and `c.get('patTokenId')`
 * so the generic rate-limit middleware (`by: 'token'`) can key off it.
 *
 * The dispatcher also:
 *   - enforces a per-token rolling rate limit in two buckets, reads apart from
 *     writes (RULES.patRead / RULES.patWrite), honoring
 *     `personal_access_tokens.rate_limit_max` overrides, and audits the first
 *     rejection of each window as `rate_limited`
 *   - records last-used timestamp + IP asynchronously
 */

import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { writeMcpAudit } from '../auth/mcp-audit.js';
import { touchPatUsage, verifyPat } from '../auth/pat.js';
import { isPatLike } from '../auth/pat-format.js';
import { type PatRequestClass, patRuleFor } from '../config/rate-limits.js';
import { userRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { parseBearerHeader } from './bearer.js';
import { getClientIp } from './rate-limit.js';

export type PatPrincipal = {
  kind: 'pat';
  /**
   * Who is at the keyboard, which `kind` cannot answer. A real PAT is a
   * person; the chat surface builds a `pat` principal too but an agent drives
   * it. Attribution follows `userId` either way — this decides whether the
   * write is treated as a human's or a machine's.
   */
  // cm:guard NEVER derive this from `kind`. `chat/tools/principal.ts` builds `kind:'pat'` for an agent-driven surface, so `kind === 'pat' ? human : agent` exempts every agent chat write from the ISS-812 fabrication guard — the guard that exists because agents were fabricating evidence. That mapping is live at mcp/tools/forge-release-batch.ts and is why this field exists.
  agency: 'human' | 'agent';
  userId: string;
  tokenId: string;
  scopes: readonly string[];
  projectIds: readonly string[] | null;
  // cm:guard non-null is BOTH the slug-omitted default and the auth fence (ISS-497), and the second of those is why a null here is not a widening to be tidied away: null means user-level, which is a token whose reach is its owner's projects. Reading it as "no project set, so no restriction" inverts the fence.
  boundProjectId: string | null;
  /**
   * The permission names this token was granted, or absent where it was
   * granted none — which is every group, not no group.
   */
  // cm:guard absent, `null` and `[]` are ONE answer here — the whole menu (ISS-973) — so do not normalize between them and do not read any of them as "holds nothing". Optional precisely because that default is the safe direction: a builder that forgets the field produces the same reach as an unmigrated row, where a required field forgotten in the other direction would lock a live integration out. `patGrantCovers` is the only reader.
  permissions?: readonly string[] | null;
  /**
   * The paired box this token was issued to, or `null` for a token a person
   * holds. It is what `requireDevice` and `/ws` resolve a device from now that
   * a device is a registry row rather than a credential (ISS-932).
   */
  // cm:guard non-null is the ENTIRE authority to act as a box, so no surface may fall back to `userId` when it is null — that is the `device.ownerId` fiction the AAT exists to remove, where a machine borrowed its owner's whole account. `middleware/require-device.ts` refuses by name instead.
  deviceId: string | null;
};

// cm:guard ONE species reaches `/mcp`, and this alias staying a single member is the whole of ISS-931. A device token authenticates `/ws` and the `requireDevice` REST routes and NOTHING here; widening it back into a union restores the second live path that ISS-894's deletions exist to remove, and it does so silently — every `principal.kind === 'pat'` test in `mcp/**` was deleted as unreachable, so the device branch would come back with no gate reading it.
export type McpPrincipal = PatPrincipal;

export type PrincipalVars = {
  principal: McpPrincipal;
  patTokenId?: string;
  patRequestClass?: PatRequestClass;
};

/**
 * Build a 401 that includes a Bearer-only WWW-Authenticate challenge. The
 * header tells RFC 6750 / MCP clients "this is bearer-token-only, don't
 * try OAuth Dynamic Client Registration" — without it, Claude Code's MCP
 * HTTP transport silently falls back to POST /register on any 401 and the
 * resulting 404 surfaces as a misleading "Invalid OAuth error response:
 * ZodError" instead of the real auth failure. The error.ts handler reads
 * `cause.wwwAuthenticate` and attaches the header before responding.
 *
 * Three challenge shapes per RFC 6750 §3:
 *   - default (no options) → `Bearer realm="forge-mcp"` — no credentials
 *     presented, client should send some.
 *   - `invalidRequest` → `…, error="invalid_request"` — credentials
 *     presented but the Authorization header is malformed (e.g. empty
 *     token, non-Bearer scheme). Tells spec-aware clients to fix the
 *     header rather than retry the same value.
 *   - `invalidToken` → `…, error="invalid_token"` — Bearer token shape is
 *     valid but the token itself was rejected by verify*.
 */
const unauth = (message: string, options?: { invalidToken?: boolean; invalidRequest?: boolean }) =>
  new HTTPException(401, {
    message,
    cause: {
      code: 'UNAUTHENTICATED',
      wwwAuthenticate: options?.invalidToken
        ? 'Bearer realm="forge-mcp", error="invalid_token"'
        : options?.invalidRequest
          ? 'Bearer realm="forge-mcp", error="invalid_request"'
          : 'Bearer realm="forge-mcp"',
    },
  });

// cm:guard a 429 from these buckets is a throttle and may never escalate into a revoke. The bucket only ever counts tokens `verifyPat` already accepted, so a guesser never reaches it and the only client it can punish is a legitimate one that is busy; the three-breaches-an-hour auto-revoke that lived here burned four of one user's tokens in a day (2026-09-03) and protected nothing. In-memory by design: a restart forgets it, which only grants a fresh window.
type PatBucket = {
  minuteCount: number;
  minuteResetAt: number;
};
// cm:guard keyed by token AND class, never by token alone: one shared bucket is what let a wave's ordinary reads spend the budget its writes then queued behind (ISS-961). `bucketKey` is the only place the two halves are named, so a class added to `PatRequestClass` needs nothing here.
const patBuckets = new Map<string, PatBucket>();

const bucketKey = (tokenId: string, requestClass: PatRequestClass) => `${tokenId}:${requestClass}`;

/**
 * Throttle map for `pat.used` WS events. The dispatcher fires once per
 * successful PAT request, but high-frequency MCP clients can hammer at many
 * Hz — without throttling we'd flood the user's WS connection. Emit at most
 * once per token per minute; the audit log remains the source of truth for
 * fine-grained per-request history.
 */
const patUsedLastEmit = new Map<string, number>();
const PAT_USED_THROTTLE_MS = 60 * 1000;

export function __resetPatBuckets(): void {
  patBuckets.clear();
  patUsedLastEmit.clear();
}

/**
 * Drop in-process throttle state for a token id. Called from PAT revoke /
 * rotate paths so the map stays bounded by active-PAT count rather than
 * lifetime-PAT count (the entry would otherwise live for the process
 * lifetime even after the token is unusable).
 */
export function forgetPatThrottle(tokenId: string): void {
  patUsedLastEmit.delete(tokenId);
  patBuckets.delete(bucketKey(tokenId, 'read'));
  patBuckets.delete(bucketKey(tokenId, 'write'));
}

interface RateLimitOutcome {
  allowed: boolean;
  max: number;
  windowMs: number;
  remaining: number;
  resetMs: number;
  firstRejectionInWindow: boolean;
}

// cm:why an explicit `rate_limit_max` caps EACH class rather than the two together: the box credential that pins one (`devices/credential.ts`) was sized at 6x a box's measured peak, and that intent is per axis — a box doing 600 reads and 600 writes in a minute is still six times anything measured.
function checkPatRateLimit(
  tokenId: string,
  requestClass: PatRequestClass,
  maxOverride: number | null,
): RateLimitOutcome {
  const rule = patRuleFor(requestClass);
  const max = maxOverride ?? rule.max;
  const windowMs = rule.windowMs;

  const key = bucketKey(tokenId, requestClass);
  const now = Date.now();
  let bucket = patBuckets.get(key);
  if (!bucket || now >= bucket.minuteResetAt) {
    bucket = { minuteCount: 0, minuteResetAt: now + windowMs };
    patBuckets.set(key, bucket);
  }

  bucket.minuteCount += 1;
  const base = { max, windowMs, resetMs: bucket.minuteResetAt - now };
  if (bucket.minuteCount > max) {
    return {
      ...base,
      allowed: false,
      remaining: 0,
      firstRejectionInWindow: bucket.minuteCount === max + 1,
    };
  }
  return {
    ...base,
    allowed: true,
    remaining: Math.max(0, max - bucket.minuteCount),
    firstRejectionInWindow: false,
  };
}

function maybeEmitPatUsed(tokenId: string, userId: string): void {
  const now = Date.now();
  const last = patUsedLastEmit.get(tokenId);
  if (last && now - last < PAT_USED_THROTTLE_MS) return;
  patUsedLastEmit.set(tokenId, now);
  roomManager.publish(userRoom(userId), {
    event: 'pat.used',
    data: { tokenId, userId, ts: new Date(now).toISOString() },
  });
}

/**
 * Verify a `forge_pat_*` token and charge it against its rate limit, or
 * return null when the token does not resolve. Throws 429 when the token is
 * over its ceiling.
 *
 * Shared with `requireAuth()` in `middleware/auth.ts`, which authenticates the
 * same tokens on the REST data plane. Extracted rather than copied so every
 * surface that accepts a PAT charges the SAME pair of buckets: the ceiling a
 * token owner reads in `X-RateLimit-Limit` is one number per class, not one
 * per surface.
 *
 * `requestClass` is which of the two budgets this request spends, decided by
 * the caller because only it knows: REST reads it off the HTTP method
 * (`pat-rest-surface.ts:scopeForMethod`), `/mcp` off the JSON-RPC envelope
 * (`mcp/request-class.ts`).
 */
// cm:guard `onVerified` fires at the ONE instant this function knows the caller is who they say, and it is the only evidence of that a thrower can leave behind: everything below may throw, and a caller that inferred authentication from the status it caught would be reading a 429 as proof of a `verifyPat` that a future upstream throttle need never have run (ISS-974). It is deliberately not a return value — the 429 path never reaches one.
export async function authenticatePat(
  c: Context,
  token: string,
  requestClass: PatRequestClass,
  onVerified?: () => void,
): Promise<PatPrincipal | null> {
  const verified = await verifyPat(token);
  if (!verified) return null;
  onVerified?.();
  const { row, ownerKind } = verified;

  const outcome = checkPatRateLimit(row.id, requestClass, row.rateLimitMax);
  c.header('X-RateLimit-Limit', String(outcome.max));
  c.header('X-RateLimit-Remaining', String(outcome.remaining));
  // cm:why the epoch second the window resets, not the seconds left: `Retry-After` already carries the delta, and a client that retries twice against a duration recomputes a moving target while an absolute reset stays true for the whole window. The generic `rateLimit()` middleware has always sent all three; this surface sent two until ISS-961.
  c.header('X-RateLimit-Reset', String(Math.ceil((Date.now() + outcome.resetMs) / 1000)));
  c.header('X-RateLimit-Scope', requestClass);
  if (!outcome.allowed) {
    // cm:why one audit row per breached window, not per rejected request — the row answers "was this token throttled, when, from where", and a client retrying at 4 Hz would otherwise write 240 rows a minute of the same answer.
    if (outcome.firstRejectionInWindow) {
      writeMcpAudit({
        userId: row.userId,
        tokenId: row.id,
        deviceId: null,
        tool: 'rate_limit',
        action: `${c.req.method} ${c.req.path}`,
        resultCode: 'rate_limited',
        ip: getClientIp(c) ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      });
    }
    const retryAfterSeconds = Math.max(1, Math.ceil(outcome.resetMs / 1000));
    const windowSeconds = Math.ceil(outcome.windowMs / 1000);
    c.header('Retry-After', String(retryAfterSeconds));
    // cm:why the body names the window, the ceiling and which of the two classes refused, because `Retry-After` alone tells a client how long to sleep and nothing about whether to sleep at all. A wave whose READS are exhausted may still write, and `scope` is the only thing in the response that says so.
    throw new HTTPException(429, {
      message:
        `rate limit exceeded: ${outcome.max} ${requestClass} request(s) per ` +
        `${windowSeconds}s on this token — retry after ${retryAfterSeconds}s`,
      cause: {
        code: 'RATE_LIMITED',
        details: {
          retryAfterSeconds,
          windowSeconds,
          limit: outcome.max,
          remaining: outcome.remaining,
          scope: requestClass,
        },
      },
    });
  }

  touchPatUsage(row.id, getClientIp(c));
  maybeEmitPatUsed(row.id, row.userId);
  // cm:guard derive `agency` from the token's OWNER and from nothing else — this is the ONE place a PAT principal is built, for `/mcp` AND for REST (`pat-rest-surface.ts:beginPatRequest` calls straight into here), so a wrong answer here is wrong on every surface at once. `agency` is what `principalActor`, `checkTransitionEvidence` and `mark_merged` read to decide whether the ISS-786/812 evidence gates apply, and those gates exist because agents fabricate evidence — so a machine credential reading `human` is the entire bypass. Every credential a machine holds is minted owned by a `kind:'agent'` user (ISS-932 wave 4), which is why the token's NAME buys nothing here and a person's token called `job:...` is inert.
  return {
    kind: 'pat',
    agency: ownerKind === 'agent' ? 'agent' : 'human',
    userId: row.userId,
    tokenId: row.id,
    scopes: row.scopes,
    projectIds: row.projectIds ?? null,
    permissions: row.permissions ?? null,
    boundProjectId: row.boundProjectId ?? null,
    deviceId: row.deviceId ?? null,
  };
}

// cm:guard the message names the CLASS and the remedy, not just the rejection. A device token is a real, paired, unexpired credential on the wrong plane, so `invalid personal access token` sends an operator to look for a PAT problem that does not exist. Until every box runs a `forge-runner` that writes the job's token into `.mcp.json` (ISS-931), this 401 is what an upgrade-lagging box reads, and it is the only place that can tell it what to do.
const DEVICE_TOKEN_REFUSAL =
  'device tokens no longer authenticate /mcp — an agent session presents its own ' +
  '`job:`/`session:` token, minted by core and written into the job MCP config by ' +
  'forge-runner. A runner box seeing this needs a newer forge-runner binary; the device ' +
  'token still authenticates /ws and the device REST routes.';

// cm:guard `/mcp` does NOT consult `permissions`, and that is a scope line rather than an oversight: ISS-972 put the MCP surface's own permission model outside ISS-973, so today a token narrowed to `issues:read` is narrowed on REST and unnarrowed here. Anyone adding the grant check to this middleware owes the menu an MCP-side mapping first — `/mcp` has tools, not `/api/...` paths, so `patGrantCovers` has nothing to match on and would refuse everything.
export const requirePat = (): MiddlewareHandler<{ Variables: PrincipalVars }> => {
  return async (c, next) => {
    const parsed = parseBearerHeader(c);
    if (parsed.kind === 'absent') throw unauth('authentication required');
    if (parsed.kind === 'malformed')
      throw unauth('invalid authorization header', { invalidRequest: true });
    const token = parsed.token;

    if (!isPatLike(token)) throw unauth(DEVICE_TOKEN_REFUSAL, { invalidToken: true });

    // cm:edge ordering -> packages/core/src/mcp/request-class.ts — `mcpRequestClass()` mounts ABOVE this middleware and is what sets the var; the `write` fallback is the stricter of the two, so a request that reached here unclassified spends the smaller budget rather than the larger one.
    const principal = await authenticatePat(c, token, c.get('patRequestClass') ?? 'write');
    if (!principal) throw unauth('invalid personal access token', { invalidToken: true });
    c.set('patTokenId', principal.tokenId);
    c.set('principal', principal);
    await next();
  };
};
