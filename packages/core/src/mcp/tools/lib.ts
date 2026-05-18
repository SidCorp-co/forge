import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { db } from '../../db/client.js';
import type { McpPrincipal } from '../../middleware/require-pat-or-device.js';
import { projectMembers, projects, runners, users } from '../../db/schema.js';
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
 * Single DB lookup for both membership and owner-or-admin checks. Returns
 * `null` when the project does not exist; otherwise `isMember` implies the
 * device owner is an owner of the project OR in `projectMembers`, and
 * `isAdmin` implies that membership has role owner|admin.
 *
 * Note: this treats project owner as a member even without a `projectMembers`
 * row — REST `/transition` requires the row separately, so MCP is slightly
 * laxer for owners. Intentional and consistent with `forge_skills.*`.
 */
async function loadDeviceProjectRole(
  device: Device,
  projectId: string,
): Promise<{ isMember: boolean; isAdmin: boolean } | null> {
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;
  if (project.ownerId === device.ownerId) return { isMember: true, isAdmin: true };
  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, device.ownerId)))
    .limit(1);
  if (!member) return { isMember: false, isAdmin: false };
  return {
    isMember: true,
    isAdmin: member.role === 'owner' || member.role === 'admin',
  };
}

/**
 * Throw if the device's owner is not a member (or owner) of the project.
 * Surfaced to the MCP caller as an `isError: true` tool result — see the
 * `server.ts` error path.
 */
export async function assertDeviceOwnerIsMember(device: Device, projectId: string): Promise<void> {
  const role = await loadDeviceProjectRole(device, projectId);
  if (!role) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!role.isMember) {
    throw new Error('FORBIDDEN: device owner is not a member of this project');
  }
}

/**
 * Throw if the device's owner is not owner/admin of the project.
 */
export async function assertDeviceOwnerIsAdmin(device: Device, projectId: string): Promise<void> {
  const role = await loadDeviceProjectRole(device, projectId);
  if (!role) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!role.isAdmin) {
    throw new Error('FORBIDDEN: requires owner or admin on the project');
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
  await assertDeviceOwnerIsMember(device, projectId);
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
  // PAT principal — check scope allowlist first.
  if (principal.projectIds !== null && !principal.projectIds.includes(projectId)) {
    throw new Error('NOT_FOUND: project not found or not accessible');
  }
  const role = await loadUserProjectRole(principal.userId, projectId);
  if (!role || !role.isMember) {
    throw new Error('NOT_FOUND: project not found or not accessible');
  }
}

export async function assertPrincipalIsAdmin(
  principal: McpPrincipal,
  projectId: string,
): Promise<void> {
  if (principal.kind === 'device') {
    await assertDeviceOwnerIsAdmin(principal.device, projectId);
    return;
  }
  if (principal.projectIds !== null && !principal.projectIds.includes(projectId)) {
    throw new Error('NOT_FOUND: project not found or not accessible');
  }
  const role = await loadUserProjectRole(principal.userId, projectId);
  if (!role) throw new Error('NOT_FOUND: project not found or not accessible');
  if (!role.isAdmin) {
    throw new Error('FORBIDDEN: requires owner or admin on the project');
  }
}

async function loadUserProjectRole(
  userId: string,
  projectId: string,
): Promise<{ isMember: boolean; isAdmin: boolean } | null> {
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;
  if (project.ownerId === userId) return { isMember: true, isAdmin: true };
  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  if (!member) return { isMember: false, isAdmin: false };
  return {
    isMember: true,
    isAdmin: member.role === 'owner' || member.role === 'admin',
  };
}

/**
 * Resolve a principal to the underlying user id — device principals expose
 * `device.ownerId`, PAT principals carry `userId` directly. Used by tools
 * that need to check user-level attributes (e.g. `users.isCeo`).
 */
export function principalUserId(principal: McpPrincipal): string {
  return principal.kind === 'device' ? principal.device.ownerId : principal.userId;
}

/**
 * Throw if the principal is not a system admin (`users.isCeo === true`).
 * Used by cross-project metrics tools that surface data outside a single
 * project's scope — same gate the analytics REST routes already enforce via
 * `loadVisibleProjectIds`.
 */
export async function assertPrincipalIsSystemAdmin(principal: McpPrincipal): Promise<void> {
  const userId = principalUserId(principal);
  const [row] = await db
    .select({ isCeo: users.isCeo })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || row.isCeo !== true) {
    throw new Error('FORBIDDEN: requires system admin');
  }
}

/**
 * Combined gate for `forge_admin_*` MCP tools (ISS-170). Checks BOTH:
 *   1. The underlying user is a system admin (`users.isCeo === true`).
 *   2. If the principal is a PAT, the token's `scopes` array includes `admin`.
 *
 * Device principals have no PAT scope vector — they pass the scope check
 * implicitly, matching the existing pattern (`assertPrincipalIsMember` etc.).
 *
 * Order matters: the isCeo check runs first so a non-admin who somehow mints
 * a PAT with `scopes:['admin']` (the create endpoint allows it; the gate is
 * at tool time) still gets the existing `requires system admin` error
 * rather than leaking that an `admin` scope path exists.
 */
export async function assertPrincipalCanAdmin(principal: McpPrincipal): Promise<void> {
  await assertPrincipalIsSystemAdmin(principal);
  if (principal.kind === 'pat' && !principal.scopes.includes('admin')) {
    throw new Error('FORBIDDEN: requires admin scope on the PAT');
  }
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
