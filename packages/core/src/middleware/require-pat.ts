/**
 * The `/mcp` credential (ISS-150, narrowed to one species by ISS-931).
 *
 * Accepts `Authorization: Bearer <token>` for a Personal Access Token
 * (`forge_pat_*`) and nothing else. Sets `c.get('principal')` to the resolved
 * {@link McpPrincipal} for downstream tool handlers, and `c.get('patTokenId')`
 * so the generic rate-limit middleware (`by: 'token'`) can key off it.
 *
 * The dispatcher also:
 *   - enforces a per-token rolling rate limit (RULES.patPerToken) honoring
 *     `personal_access_tokens.rate_limit_max` overrides, and audits the first
 *     rejection of each window as `rate_limited`
 *   - records last-used timestamp + IP asynchronously
 */

import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { writeMcpAudit } from '../auth/mcp-audit.js';
import { touchPatUsage, verifyPat } from '../auth/pat.js';
import {
  isMachineTokenName,
  isPatLike,
  type MachineTokenRef,
  parseMachineTokenName,
} from '../auth/pat-format.js';
import { RULES } from '../config/rate-limits.js';
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
   * The job or unattended session this token was minted for, read off its
   * name — `null` for a person's PAT. It is what gives a tool its pipeline
   * context now that the caller has no device to look one up by.
   */
  machine: MachineTokenRef | null;
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

// cm:guard a 429 from this bucket is a throttle and may never escalate into a revoke. The bucket only ever counts tokens `verifyPat` already accepted, so a guesser never reaches it and the only client it can punish is a legitimate one that is busy; the three-breaches-an-hour auto-revoke that lived here burned four of one user's tokens in a day (2026-09-03) and protected nothing. In-memory by design: a restart forgets it, which only grants a fresh window.
type PatBucket = {
  minuteCount: number;
  minuteResetAt: number;
};
const patBuckets = new Map<string, PatBucket>();

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
  patBuckets.delete(tokenId);
}

interface RateLimitOutcome {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  firstRejectionInWindow: boolean;
}

function checkPatRateLimit(tokenId: string, maxOverride: number | null): RateLimitOutcome {
  const max = maxOverride ?? RULES.patPerToken.max;
  const windowMs = RULES.patPerToken.windowMs;

  const now = Date.now();
  let bucket = patBuckets.get(tokenId);
  if (!bucket || now >= bucket.minuteResetAt) {
    bucket = { minuteCount: 0, minuteResetAt: now + windowMs };
    patBuckets.set(tokenId, bucket);
  }

  bucket.minuteCount += 1;
  if (bucket.minuteCount > max) {
    return {
      allowed: false,
      remaining: 0,
      resetMs: bucket.minuteResetAt - now,
      firstRejectionInWindow: bucket.minuteCount === max + 1,
    };
  }
  return {
    allowed: true,
    remaining: Math.max(0, max - bucket.minuteCount),
    resetMs: bucket.minuteResetAt - now,
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
 * surface that accepts a PAT charges the SAME bucket: the ceiling a token
 * owner reads in `X-RateLimit-Limit` is one number, not one per surface.
 */
export async function authenticatePat(c: Context, token: string): Promise<PatPrincipal | null> {
  const verified = await verifyPat(token);
  if (!verified) return null;
  const { row, ownerKind } = verified;

  const outcome = checkPatRateLimit(row.id, row.rateLimitMax);
  c.header('X-RateLimit-Limit', String(row.rateLimitMax ?? RULES.patPerToken.max));
  c.header('X-RateLimit-Remaining', String(outcome.remaining));
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
    c.header('Retry-After', String(retryAfterSeconds));
    throw new HTTPException(429, {
      message: 'rate limit exceeded',
      cause: { code: 'RATE_LIMITED', details: { retryAfterSeconds } },
    });
  }

  touchPatUsage(row.id, getClientIp(c));
  maybeEmitPatUsed(row.id, row.userId);
  // cm:guard derive `agency` from the token, never assume `human` — this is the ONE place a PAT principal is built, for `/mcp` AND for REST (`pat-rest-surface.ts:beginPatRequest` calls straight into here), so a wrong constant here is wrong on every surface at once. A `job:` token is minted for an agent, delivered to the runner on `job.assigned`, and exported as `$FORGE_PAT`; a `session:` token is the same thing for an unattended chat/schedule session, delivered on `agent:start` (ISS-927). Stamped `human` either makes `principalActor` return `{type:'user'}`, which is the exact input `checkTransitionEvidence` and `mark_merged` use to SKIP the ISS-786/812 evidence gates. The gates were added because agents fabricate evidence, so the credential built for agents was the one class exempt from them. Read the FAMILY (`isMachineTokenName`), never one member — a species minted but tested for by name is the same hole wearing a new prefix.
  return {
    kind: 'pat',
    // cm:guard the OR is the whole shape and neither half may be dropped. `users.kind` answers for an AAT, whose owner IS an agent (ISS-932); `isMachineTokenName` answers for a `job:`/`session:` token, which is minted from a HUMAN's `jobs.created_by` and would read `human` off the kind alone. Deleting the name half is wave 4 of ISS-932 and cannot happen while those tokens are minted, or every job write is stamped a person's and skips the ISS-786/812 evidence gates.
    agency: ownerKind === 'agent' || isMachineTokenName(row.name) ? 'agent' : 'human',
    userId: row.userId,
    tokenId: row.id,
    scopes: row.scopes,
    projectIds: row.projectIds ?? null,
    boundProjectId: row.boundProjectId ?? null,
    deviceId: row.deviceId ?? null,
    machine: parseMachineTokenName(row.name),
  };
}

// cm:guard the message names the CLASS and the remedy, not just the rejection. A device token is a real, paired, unexpired credential on the wrong plane, so `invalid personal access token` sends an operator to look for a PAT problem that does not exist. Until every box runs a `forge-runner` that writes the job's token into `.mcp.json` (ISS-931), this 401 is what an upgrade-lagging box reads, and it is the only place that can tell it what to do.
const DEVICE_TOKEN_REFUSAL =
  'device tokens no longer authenticate /mcp — an agent session presents its own ' +
  '`job:`/`session:` token, minted by core and written into the job MCP config by ' +
  'forge-runner. A runner box seeing this needs a newer forge-runner binary; the device ' +
  'token still authenticates /ws and the device REST routes.';

export const requirePat = (): MiddlewareHandler<{ Variables: PrincipalVars }> => {
  return async (c, next) => {
    const parsed = parseBearerHeader(c);
    if (parsed.kind === 'absent') throw unauth('authentication required');
    if (parsed.kind === 'malformed')
      throw unauth('invalid authorization header', { invalidRequest: true });
    const token = parsed.token;

    if (!isPatLike(token)) throw unauth(DEVICE_TOKEN_REFUSAL, { invalidToken: true });

    const principal = await authenticatePat(c, token);
    if (!principal) throw unauth('invalid personal access token', { invalidToken: true });
    c.set('patTokenId', principal.tokenId);
    c.set('principal', principal);
    await next();
  };
};
