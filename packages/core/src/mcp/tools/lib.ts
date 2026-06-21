import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { db } from '../../db/client.js';
import { projects, runners } from '../../db/schema.js';
import {
  effectiveProjectRole,
  loadVisibleProjectIds,
  projectRoleAtLeast,
} from '../../lib/authz.js';
import type { McpPrincipal } from '../../middleware/require-pat-or-device.js';
import type { McpTool } from './forge-version.js';

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
 * Effective-role lookup shared by the device and PAT paths. Returns `null`
 * when the project does not exist. `isMember` = any effective role (viewer
 * counts — use for READ tools); `isWriter` = member or admin (use for
 * mutating tools — viewer is read-only); `isAdmin` = effective project admin
 * (explicit row OR org owner/admin — lib/authz.ts).
 */
async function loadUserProjectRoleFlags(
  userId: string,
  projectId: string,
): Promise<{ isMember: boolean; isWriter: boolean; isAdmin: boolean } | null> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access) return null;
  return {
    isMember: access.role !== null,
    isWriter: projectRoleAtLeast(access.role, 'member'),
    isAdmin: projectRoleAtLeast(access.role, 'admin'),
  };
}

/**
 * Throw if the device's owner is not a member (or owner) of the project.
 * Surfaced to the MCP caller as an `isError: true` tool result — see the
 * `server.ts` error path.
 */
export async function assertDeviceOwnerIsMember(device: Device, projectId: string): Promise<void> {
  const role = await loadUserProjectRoleFlags(device.ownerId, projectId);
  if (!role) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!role.isMember) {
    throw new Error('FORBIDDEN: device owner is not a member of this project');
  }
}

/**
 * Throw if the device's owner cannot WRITE (effective role below `member` —
 * viewer is read-only across the MCP surface too).
 */
export async function assertDeviceOwnerIsWriter(device: Device, projectId: string): Promise<void> {
  const role = await loadUserProjectRoleFlags(device.ownerId, projectId);
  if (!role) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!role.isWriter) {
    throw new Error('FORBIDDEN: requires project member access (viewer is read-only)');
  }
}

/**
 * Throw if the device's owner is not an effective project admin.
 */
export async function assertDeviceOwnerIsAdmin(device: Device, projectId: string): Promise<void> {
  const role = await loadUserProjectRoleFlags(device.ownerId, projectId);
  if (!role) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!role.isAdmin) {
    throw new Error('FORBIDDEN: requires project admin access');
  }
}

/**
 * Gate for `forge_pm.*` write tools (Epic 3, ISS-19). Caller must:
 *   1. be a member of the project, AND
 *   2. own a `claude-code` runner whose `capabilities.pm` is `true`.
 *
 * The `capabilities.pm` flag is the explicit opt-in that lets a single
 * `claude-code` runner act as the PM agent for the project. The
 * `runners_device_type_uq` partial unique index pins at most one
 * `claude-code` runner per device, so toggling the flag on that row is the
 * only path to enable PM tools for the device.
 */
export async function assertPmActor(device: Device, projectId: string): Promise<void> {
  await assertDeviceOwnerIsWriter(device, projectId);
  const [runner] = await db
    .select({ capabilities: runners.capabilities })
    .from(runners)
    .where(and(eq(runners.deviceId, device.id), eq(runners.type, 'claude-code')))
    .limit(1);
  if (!runner) {
    throw new Error('FORBIDDEN: device has no claude-code runner registered');
  }
  const caps = (runner.capabilities ?? {}) as Record<string, unknown>;
  if (caps.pm !== true) {
    throw new Error('FORBIDDEN: PM tools require runner capabilities.pm=true');
  }
}

/**
 * ISS-497 — the effective project allowlist for a principal. A project-level
 * PAT (`boundProjectId` set) is fenced to exactly its bound project, as if
 * `projectIds` contained only `[boundProjectId]`; binding and a multi-project
 * `projectIds` are mutually exclusive at mint. A user-level PAT keeps its
 * `projectIds` allowlist (NULL = inherit all the user's memberships). Device
 * principals have no PAT allowlist → `null` (unrestricted, gated by role).
 *
 * Folding the binding in here is what makes the cross-project conflict rule
 * (explicit arg/slug ≠ bound → NOT_FOUND) fall out of the existing fence
 * checks with no bespoke branch.
 */
export function patEffectiveProjectIds(principal: McpPrincipal): readonly string[] | null {
  if (principal.kind !== 'pat') return null;
  if (principal.boundProjectId) return [principal.boundProjectId];
  return principal.projectIds;
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
  if (!role || !role.isMember) {
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
  if (!role || !role.isMember) {
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
 * The set of project ids a principal can see: projects the underlying user
 * owns OR is a member of, intersected with the PAT's `projectIds` allowlist
 * when present. There is no cross-tenant bypass — every principal is scoped
 * to its own projects. Used by the project-scoped fleet tools (`forge_runners`,
 * `forge_collaborators`, `forge_ops_health`) and the cross-project metrics tool
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
 * Resolve a project slug (typically from `X-Forge-Project-Slug`) to its UUID.
 * Throws BAD_REQUEST when the slug is missing and NOT_FOUND when no project
 * matches. Tools that use slug-based scoping call this before
 * {@link assertDeviceOwnerIsMember}.
 */
export async function resolveProjectIdFromSlug(slug: string | null): Promise<string> {
  if (!slug) {
    throw new Error(
      'BAD_REQUEST: project context missing — set X-Forge-Project-Slug header or pass projectId',
    );
  }
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  if (!row) throw new Error(`NOT_FOUND: project not found for slug "${slug}"`);
  return row.id;
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
