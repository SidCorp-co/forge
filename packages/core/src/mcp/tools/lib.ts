import { z } from 'zod';
import { type ActorAgency, actorAgency, type TransitionActor } from '../../issues/actor-agency.js';
import { loadVisibleProjectIds } from '../../lib/authz.js';
import { type Refusal, type RefusalEnvelope, refusalEnvelope } from '../../lib/refusal.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import type { Actor } from '../../pipeline/activity.js';
import {
  listVisibleProjectsWithRole,
  type VisibleProjectWithRole,
} from '../../projects/service.js';
import type { ToolGrant, ToolReach, ToolRoute } from '../tool-grant.js';
import { patEffectiveProjectIds, resolveProjectIdFromSlug } from './project-scope.js';

/** The shape every registered MCP tool has, whatever produced it. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  grant: ToolGrant;
  reach: ToolReach;
  route?: ToolRoute;
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
  ecosystemId?: string | null;
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
  /**
   * A chat turn's own token, for a tool that hands the turn's authority to a child process
   * (the `forge` CLI). Absent on `/mcp`, where the caller already holds its token.
   */
  turnToken?: string;
  /**
   * A chat turn's bound: the grant of the credential the person reached Forge with, null where
   * their project role is the whole bound (ISS-17). Absent on `/mcp`, where
   * `principal.permissions` is the grant each tool's declared `grant` is read against.
   */
  grant?: readonly string[] | null;
  fence?: readonly string[] | null;
  /** ISS-150 audit-log fields, threaded through for `writeMcpAudit`. */
  requestId?: string;
  ip?: string | null;
  userAgent?: string | null;
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

/** The user a principal acts as. */
export function principalUserId(principal: McpPrincipal): string {
  return principal.userId;
}

/**
 * Who a call's writes are recorded as: the paired box a token is bound to, with its holder kept as
 * the owner, or else the account holding the token, carrying that account's agency. A box names its
 * own `devices` row, so the audit resolves to the box and the person behind it.
 */
export function principalActor(principal: McpPrincipal): TransitionActor {
  if (principal.deviceId) {
    return { type: 'device', id: principal.deviceId, ownerId: principal.userId };
  }
  return { type: 'user', id: principal.userId, agency: principal.agency };
}

/**
 * The `devices` row that stands for the agent behind this call, or `null` when
 * a person's own PAT made it.
 */
export function principalAuthorDeviceId(principal: McpPrincipal): string | null {
  return principal.deviceId;
}

/** Who was at the keyboard for this MCP call, as the kernel audit records it. */
export function principalAgency(principal: McpPrincipal): ActorAgency {
  return actorAgency(principalActor(principal));
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

/** The REST refusal body, flagged `isError`, so both doors answer one shape. */
export function refusedAnswer(
  refusals: readonly Refusal[],
  fallbackCode: string,
): RefusalEnvelope & { _mcpIsError: true } {
  return { _mcpIsError: true, ...refusalEnvelope(refusals, fallbackCode) };
}
