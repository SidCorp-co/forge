import { z } from 'zod';
import { type ActorAgency, actorAgency, type TransitionActor } from '../../issues/actor-agency.js';
import { loadVisibleProjectIds } from '../../lib/authz.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import type { Actor } from '../../pipeline/activity.js';
import {
  listVisibleProjectsWithRole,
  type VisibleProjectWithRole,
} from '../../projects/service.js';
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
/** The room a chat turn answers in and who it answers, for the speaker-bound tools (ISS-1034). */
export interface ChatTurnFacts {
  conversationId: string | null;
  speakerUserId: string | null;
  /** The handle participant answering for this project in the room; null where none is in it. */
  handleUserId: string | null;
}

export type McpContext = {
  principal: McpPrincipal;
  projectSlug: string | null;
  boundProjectId?: string | null;
  /**
   * ISS-1034 — what a CHAT turn tells the tools that write on the speaker's
   * behalf. Absent on every `/mcp` transport request: a PAT holder speaks for
   * itself, and `handler.ts` never sets it.
   */
  turn?: ChatTurnFacts;
  /** ISS-150 audit-log fields, threaded through for `writeMcpAudit`. */
  requestId?: string;
  ip?: string | null;
  userAgent?: string | null;
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

export function principalActor(principal: McpPrincipal): TransitionActor {
  return principal.agency === 'agent'
    ? { type: 'device', id: principal.tokenId, ownerId: principal.userId }
    : { type: 'user', id: principal.userId, agency: principal.agency };
}

/**
 * The `devices` row that stands for the agent behind this call, or `null` when
 * a person's own PAT made it.
 */
export function principalAuthorDeviceId(principal: McpPrincipal): string | null {
  return principal.deviceId;
}

/**
 * Who was at the keyboard for this MCP call, as the kernel audit records it.
 *
 * Distinct from {@link principalActor}, which answers who OWNS the write. The
 * token's `job:`/`session:` name prefix already decided this.
 */
export function principalAgency(principal: McpPrincipal): ActorAgency {
  return actorAgency(principalActor(principal));
}

/**
 * What this credential ESTABLISHED about who is speaking, or `null` for a
 * person's own token, which establishes nothing (ISS-1003).
 */
export function principalEstablishedAgency(principal: McpPrincipal): ActorAgency | null {
  return principal.agency;
}

/** The same decision, in the shape the hooks bus and `activity_log` take. */
export function principalHookActor(principal: McpPrincipal): Actor {
  const actor = principalActor(principal);
  return { type: actor.type, id: actor.id, agency: actorAgency(actor) };
}

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

export async function loadVisibleProjectsWithRoleForPrincipal(
  principal: McpPrincipal,
): Promise<VisibleProjectWithRole[]> {
  const rows = await listVisibleProjectsWithRole(principalUserId(principal));
  const allow = patEffectiveProjectIds(principal);
  if (allow === null) return rows;
  const allowSet = new Set(allow);
  return rows.filter((r) => allowSet.has(r.id));
}

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
