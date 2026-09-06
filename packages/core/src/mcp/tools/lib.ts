import { z } from 'zod';
import { type ActorAgency, actorAgency, type TransitionActor } from '../../issues/actor-agency.js';
import { resolveMachineTokenDeviceId } from '../../jobs/active-job-context.js';
import { loadVisibleProjectIds } from '../../lib/authz.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import type { Actor } from '../../pipeline/activity.js';
import { loadUserProjectRoleFlags } from './project-authz.js';
import { patEffectiveProjectIds, resolveProjectIdFromSlug } from './project-scope.js';

/** The shape every registered MCP tool has, whatever produced it. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Per-request context passed to tool factories.
 *
 * `projectSlug` is the optional `X-Forge-Project-Slug` header — tools that
 * scope by project resolve it via {@link resolveProjectIdFromSlug}.
 */
// cm:guard there is NO device on this context and a new tool may not reintroduce one. Until ISS-931 it carried a `device` that `mcp/handler.ts` fabricated for every PAT — a row with a token id in its `id` column and `__pat_synthetic__` for a name — and the membership helpers it fed read only `ownerId`, so the 14 tools taking it never consulted the PAT `projectIds` allowlist. Gate through `assertPrincipalIsMember`/`assertPrincipalIsWriter`, which read the principal and DO consult it.
export type McpContext = {
  principal: McpPrincipal;
  projectSlug: string | null;
  /**
   * ISS-497 — the project a project-level PAT is bound to (NULL for a
   * user-level token). Threaded from
   * `principal.boundProjectId` in `handler.ts` so the effective-project
   * resolution (arg > slug > boundProjectId) and `metaProjectId()` share a
   * single source of truth. Optional so the many minimal test contexts that
   * predate ISS-497 stay valid (absent → no binding, identical to null);
   * `handler.ts` always sets it for real requests.
   */
  boundProjectId?: string | null;
  /** ISS-150 audit-log fields, threaded through for `writeMcpAudit`. */
  requestId?: string;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * ISS-145 — per-request collector for deprecated tool names invoked
   * during this MCP call. Shim factories push the legacy tool name they
   * implement; `handler.ts` reads this after the transport response and
   * emits an `X-MCP-Deprecation` header. Always present (initialized in
   * `handler.ts`) but typed optional so unit tests that build a minimal
   * context can omit it without TS errors.
   */
  deprecations?: Set<string>;
};

/**
 * Context-scoped MCP tool — receives the full {@link McpContext}. The only
 * factory shape there is.
 */
export type ContextScopedMcpToolFactory = (ctx: McpContext) => McpTool;

/**
 * Convert a Zod schema to MCP JSON Schema. Zod v4 exposes this natively.
 */
export function zodToMcpSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/**
 * Membership check (ISS-150): the token's `projectIds` allowlist AND the
 * underlying user being a member of the project.
 *
 * On scope-allowlist miss we throw `NOT_FOUND` instead of `FORBIDDEN` so a
 * probing caller cannot enumerate the project namespace via an
 * existence-leaking 403. The MCP error mapper in `server.ts` translates this
 * to a generic `isError: true` response.
 */
export async function assertPrincipalIsMember(
  principal: McpPrincipal,
  projectId: string,
): Promise<void> {
  const allow = patEffectiveProjectIds(principal);
  if (allow !== null && !allow.includes(projectId)) {
    throw new Error('NOT_FOUND: project not found or not accessible');
  }
  const role = await loadUserProjectRoleFlags(principal.userId, projectId);
  if (!role?.isMember) {
    throw new Error('NOT_FOUND: project not found or not accessible');
  }
}

/**
 * Writer gate for mutating tools: effective role must be at least `member`
 * (viewer is read-only). Same existence-hiding semantics as
 * {@link assertPrincipalIsMember}; the below-member case gets a truthful
 * FORBIDDEN since the caller can already see the project.
 */
export async function assertPrincipalIsWriter(
  principal: McpPrincipal,
  projectId: string,
): Promise<void> {
  const allow = patEffectiveProjectIds(principal);
  if (allow !== null && !allow.includes(projectId)) {
    throw new Error('NOT_FOUND: project not found or not accessible');
  }
  const role = await loadUserProjectRoleFlags(principal.userId, projectId);
  if (!role?.isMember) {
    throw new Error('NOT_FOUND: project not found or not accessible');
  }
  if (!role.isWriter) {
    throw new Error('FORBIDDEN: requires project member access (viewer is read-only)');
  }
}

/**
 * Admin gate. Also requires the `admin` scope on the token — the single
 * enforcement point for the scope (it was declared since ISS-150 but never
 * checked; pre-0106 tokens are grandfathered by migration).
 */
export async function assertPrincipalIsAdmin(
  principal: McpPrincipal,
  projectId: string,
): Promise<void> {
  const allow = patEffectiveProjectIds(principal);
  if (allow !== null && !allow.includes(projectId)) {
    throw new Error('NOT_FOUND: project not found or not accessible');
  }
  if (!principal.scopes.includes('admin')) {
    throw new Error('FORBIDDEN: this token lacks the admin scope');
  }
  const role = await loadUserProjectRoleFlags(principal.userId, projectId);
  if (!role) throw new Error('NOT_FOUND: project not found or not accessible');
  if (!role.isAdmin) {
    throw new Error('FORBIDDEN: requires project admin access');
  }
}

/** The user a principal acts as. */
export function principalUserId(principal: McpPrincipal): string {
  return principal.userId;
}

/**
 * Who this MCP call records as having acted.
 *
 * Attribution follows the token's owner — a person holding a PAT is written
 * down as that person. Everything downstream that branches on `actor.type`
 * then lands correctly on its own: the ISS-812 fabrication guard skips a human
 * and covers an agent, and `publishIssueStatusChange` names a user id that
 * exists.
 */
// cm:guard branch on `agency` and on nothing else. Since ISS-931 every `/mcp` principal is a PAT, so a `kind`-shaped test would now read EVERY caller as a human and hand all of them the ISS-812 exemption — the guard added because agents were fabricating evidence. `agency` is the only field that separates a person's token from a `job:`/`session:` one.
// cm:why the agent branch's `id` is the TOKEN id, which matches no `devices` row. That is not new and is not a thing this function can fix: it is the exact value `mcp/handler.ts` used to fabricate (`stubDeviceForPat(userId, tokenId)` set `id: tokenId`), kept identical when ISS-931 deleted the stub so no attribution moved with it. Whether an agent MCP write should be `{type:'user', agency:'agent'}` instead is a live question about `actor-resolution.ts:isAgent` and `outbox-worker.ts`, not a rename.
export function principalActor(principal: McpPrincipal): TransitionActor {
  return principal.agency === 'human'
    ? { type: 'user', id: principal.userId }
    : { type: 'device', id: principal.tokenId, ownerId: principal.userId };
}

/**
 * The `devices` row that stands for the agent behind this call, or `null` when
 * a person's own PAT made it.
 */
// cm:guard the `jobs` hop lives HERE rather than in the tool that wants it. `forge-comments.ts` reached a 7th module the moment it resolved the job off the token itself, which is one past `no-coordinator-blob`'s limit of 6 in `.arch.json`; this file already owns every other principal-to-attribution mapping (`principalActor`, `principalHookActor`, `principalAgency`), so the hop belongs beside them and a second tool needing the marker calls this instead of importing `jobs` again.
export function principalAuthorDeviceId(principal: McpPrincipal): Promise<string | null> {
  return resolveMachineTokenDeviceId(principal.machine);
}

/**
 * Who was at the keyboard for this MCP call, as the kernel audit records it.
 *
 * Distinct from {@link principalActor}, which answers who OWNS the write. The
 * token's `job:`/`session:` name prefix already decided this.
 */
export function principalAgency(principal: McpPrincipal): ActorAgency {
  return principal.agency;
}

/** The same decision, in the shape the hooks bus and `activity_log` take. */
export function principalHookActor(principal: McpPrincipal): Actor {
  const actor = principalActor(principal);
  // cm:guard derive through `actorAgency`, not by re-testing `type === 'device'` here — that spelling is right ONLY because `principalActor` above already routes an agent-held PAT into the device branch. Loosen that mapping so an agent keeps `type:'user'` and a local test silently starts recording every agent write as a human, whereas this call follows it.
  return { type: actor.type, id: actor.id, agency: actorAgency(actor) };
}

/**
 * The set of project ids a principal can see: projects the underlying user
 * owns OR is a member of, intersected with the PAT's `projectIds` allowlist
 * when present. There is no cross-tenant bypass — every principal is scoped
 * to its own projects. Used by the project-scoped fleet tools (`forge_runners`,
 * `forge_collaborators`) and the cross-project metrics tool
 * to bound their result sets to the caller.
 *
 * Mirrors the REST `loadVisibleProjectIds` (pipeline/analytics-routes.ts).
 */
export async function loadVisibleProjectIdsForPrincipal(
  principal: McpPrincipal,
): Promise<string[]> {
  let ids = await loadVisibleProjectIds(principalUserId(principal));
  const allow = patEffectiveProjectIds(principal);
  if (allow !== null) {
    const allowSet = new Set(allow);
    ids = ids.filter((id) => allowSet.has(id));
  }
  return ids;
}

/**
 * ISS-497 — resolve the effective project id for a tool call, computed once
 * and shared by every project-scoped tool AND the managed-meta-prompt path
 * (`metaProjectId()` in server.ts). Precedence (highest first):
 *
 *   1. explicit `projectId` arg on the tool call
 *   2. `X-Forge-Project-Slug` header (`ctx.projectSlug`)
 *   3. `boundProjectId` (project-level PAT only) — returned directly, no slug
 *      round-trip
 *   4. BAD_REQUEST (unchanged for user-level tokens with nothing supplied)
 *
 * This only RESOLVES the id. The cross-project conflict rule (an explicit
 * arg/slug that resolves to a project ≠ the bound project) is enforced by the
 * effective-allowlist fence inside {@link assertPrincipalIsMember} /
 * `assertPrincipalIsWriter` / `assertPrincipalIsAdmin`, which every
 * project-scoped tool calls after resolving — so a conflict surfaces as
 * NOT_FOUND, never a bespoke 403.
 */
export async function resolveEffectiveProjectId(
  ctx: McpContext,
  explicitProjectId?: string | null,
): Promise<string> {
  if (explicitProjectId) return explicitProjectId;
  if (ctx.projectSlug) return resolveProjectIdFromSlug(ctx.projectSlug);
  if (ctx.boundProjectId) return ctx.boundProjectId;
  throw new Error(
    'BAD_REQUEST: project context missing — set X-Forge-Project-Slug header or pass projectId',
  );
}
