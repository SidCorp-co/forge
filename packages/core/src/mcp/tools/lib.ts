import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { actorAgency, type DeviceLite, type TransitionActor } from '../../issues/actor-agency.js';
import { loadVisibleProjectIds } from '../../lib/authz.js';
import type { McpPrincipal } from '../../middleware/require-pat-or-device.js';
import type { Actor } from '../../pipeline/activity.js';
import {
  assertDeviceOwnerIsAdmin,
  assertDeviceOwnerIsMember,
  assertDeviceOwnerIsWriter,
  loadUserProjectRoleFlags,
} from './project-authz.js';
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
 * `device` is non-null only when the principal is a paired device — kept on
 * the context for legacy device-only tools (forge_pm_*, forge_jobs.*, etc.)
 * that were written before PAT auth existed. Newer tools should branch on
 * `principal.kind` directly via {@link assertPrincipalIsMember}.
 *
 * `projectSlug` is the optional `X-Forge-Project-Slug` header — tools that
 * scope by project resolve it via {@link resolveProjectIdFromSlug}.
 */
export type McpContext = {
  principal: McpPrincipal;
  /**
   * Always set so legacy device-only tool factories keep their signatures.
   * For PAT principals this is a synthesized stub whose `ownerId` is the
   * PAT user — the membership helpers below only read `ownerId`. PAT users
   * have no `id` that maps to a real `devices` row, so checks that pivot on
   * `device.id` (e.g. `assertPmActor` querying `runners.deviceId = device.id`)
   * naturally fail for them. That is the desired behaviour — PM tools
   * require a real claude-code runner, which only paired devices can host.
   */
  device: Device;
  projectSlug: string | null;
  /**
   * ISS-497 — the project a project-level PAT is bound to (NULL for
   * user-level tokens and device principals). Threaded from
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
 * Device-scoped MCP tool — receives the authenticated `Device` at build time
 * so the handler can enforce project membership.
 */
export type DeviceScopedMcpToolFactory = (device: Device) => McpTool;

/**
 * Context-scoped MCP tool — receives the full {@link McpContext} (device +
 * optional project slug). Use for tools that resolve project from the
 * `X-Forge-Project-Slug` header rather than an explicit args field.
 */
export type ContextScopedMcpToolFactory = (ctx: McpContext) => McpTool;

/**
 * Convert a Zod schema to MCP JSON Schema. Zod v4 exposes this natively.
 */
export function zodToMcpSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/**
 * Principal-aware membership check (ISS-150). Wraps the device-scoped
 * helper above and adds the PAT path:
 *   - device principal → existing assertDeviceOwnerIsMember
 *   - PAT principal → check `projectIds` allowlist AND the underlying user
 *     is a member of the project.
 *
 * On scope-allowlist miss for a PAT, we throw `NOT_FOUND` instead of
 * `FORBIDDEN` so a probing caller cannot enumerate the project namespace
 * via an existence-leaking 403. The MCP error mapper in `server.ts`
 * translates this to a generic `isError: true` response.
 */
export async function assertPrincipalIsMember(
  principal: McpPrincipal,
  projectId: string,
): Promise<void> {
  if (principal.kind === 'device') {
    await assertDeviceOwnerIsMember(principal.device, projectId);
    return;
  }
  // PAT principal — check the effective allowlist (bound project fences here).
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
  if (principal.kind === 'device') {
    await assertDeviceOwnerIsWriter(principal.device, projectId);
    return;
  }
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
 * Admin gate. For PAT principals this ALSO requires the `admin` scope on the
 * token — the single enforcement point for the scope (it was declared since
 * ISS-150 but never checked; pre-0106 tokens are grandfathered by migration).
 * Device tokens carry no scopes: a paired desktop acts as the user.
 */
export async function assertPrincipalIsAdmin(
  principal: McpPrincipal,
  projectId: string,
): Promise<void> {
  if (principal.kind === 'device') {
    await assertDeviceOwnerIsAdmin(principal.device, projectId);
    return;
  }
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

/**
 * Resolve a principal to the underlying user id — device principals expose
 * `device.ownerId`, PAT principals carry `userId` directly. Used by tools
 * that need to check user-level attributes or scope by ownership.
 */
export function principalUserId(principal: McpPrincipal): string {
  return principal.kind === 'device' ? principal.device.ownerId : principal.userId;
}

/**
 * Who this MCP call records as having acted.
 *
 * Attribution follows the token's owner — a person holding a PAT is written
 * down as that person, not as the synthetic device the PAT is carried on.
 * Everything downstream that branches on `actor.type` then lands correctly on
 * its own: the ISS-812 fabrication guard skips a human and covers an agent,
 * and `publishIssueStatusChange` names a user id that exists.
 */
// cm:guard branch on `agency`, NEVER on `kind`. A `kind === 'pat'` test reads the agent-driven chat surface (chat/tools/principal.ts) as a human and hands it the ISS-812 exemption — the guard added because agents were fabricating evidence. `agency` is the only field that separates the two.
export function principalActor(principal: McpPrincipal, device: DeviceLite): TransitionActor {
  return principal.kind === 'pat' && principal.agency === 'human'
    ? { type: 'user', id: principal.userId }
    : { type: 'device', id: device.id, ownerId: device.ownerId };
}

/** The same decision, in the shape the hooks bus and `activity_log` take. */
export function principalHookActor(principal: McpPrincipal, device: DeviceLite): Actor {
  const actor = principalActor(principal, device);
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
