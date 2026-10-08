// The shape every agent tool has, whichever module holds it and whichever door serves it: the MCP
// registry (`mcp/registry.ts`) and the chat assistant's toolsets both take these.

import { z } from 'zod';
import type { PatPermission, PatRoute } from '../credentials/pat-permissions.js';
import type { McpPrincipal } from '../middleware/require-pat.js';
import { loadVisibleProjectIds } from './authz.js';
import { type Refusal, type RefusalEnvelope, refusalEnvelope } from './refusal.js';
import type { BlockStage } from './staged-block.js';

export type ToolGrantNone = { readonly none: string };

export type ToolGrantEntry = PatPermission | ToolGrantNone;

/** An action the per-action table does not name is refused, never let through. */
export type ToolGrant =
  | ToolGrantEntry
  | {
      readonly byAction: Readonly<Record<string, ToolGrantEntry>>;
      readonly defaultAction?: string;
    };

/**
 * Where a tool's work lands. `project`: in one project, which the tool resolves and fences
 * itself. `public`: in no project and on nothing private, beside a `none` grant. `{ account }`:
 * beyond any one project, so a token fenced to projects is refused; the text names the work.
 */
export type ToolReachEntry = 'project' | 'public' | { readonly account: string };

export type ToolReach =
  | ToolReachEntry
  | { readonly byAction: Readonly<Record<string, ToolReachEntry>> };

/**
 * The REST mount serving a tool's rows, one per resource its grants name, so a token is refused a
 * tool exactly where REST refuses it the route.
 */
export type ToolRoute = PatRoute | readonly PatRoute[];

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  grant: ToolGrant;
  reach: ToolReach;
  route?: ToolRoute;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** The room a chat turn answers in and who it answers, for the speaker-bound tools. */
export interface ChatTurnFacts {
  conversationId: string | null;
  speakerUserId: string | null;
  /** The handle participant answering for this project in the room; null where none is in it. */
  handleUserId: string | null;
  ecosystemId?: string | null;
  /** The images the speaker sent with this message, which a Feedback item the turn records carries. */
  images?: readonly { name: string; mime: string; dataBase64: string }[];
  /**
   * A document attached in this turn's room, read by its file name as scrubbed text, for a tool that
   * takes the document's own lines rather than the model's retyping of them.
   */
  readDocument?: (file: string) => Promise<TurnDocument>;
  /**
   * Where a block this turn draws waits until the turn's reply is judged; absent where the turn's
   * door draws no block.
   */
  blockStage?: BlockStage;
}

export type TurnDocument =
  | { ok: true; name: string; mime: string; text: string; redacted: boolean }
  | { ok: false; reason: string };

/**
 * Per-request context passed to tool factories. `projectSlug` is the optional
 * `X-Forge-Project-Slug` header.
 */
export type McpContext = {
  principal: McpPrincipal;
  projectSlug: string | null;
  boundProjectId?: string | null;
  /**
   * What a chat turn tells the tools that write on the speaker's behalf. Absent on every `/mcp`
   * request: a PAT holder speaks for itself.
   */
  turn?: ChatTurnFacts;
  /**
   * A chat turn's own token, for a tool that hands the turn's authority to a child process
   * (the `forge` CLI). Absent on `/mcp`, where the caller already holds its token.
   */
  turnToken?: string;
  /**
   * A chat turn's bound: the grant of the credential the person reached Forge with, null where
   * their project role is the whole bound. Absent on `/mcp`, where `principal.permissions` is the
   * grant each tool's declared `grant` is read against.
   */
  grant?: readonly string[] | null;
  fence?: readonly string[] | null;
  /** Audit-log fields, threaded through for `writeMcpAudit`. */
  requestId?: string;
  ip?: string | null;
  userAgent?: string | null;
};

export type ContextScopedMcpToolFactory = (ctx: McpContext) => McpTool;

export function zodToMcpSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/** The user a principal acts as. */
export function principalUserId(principal: McpPrincipal): string {
  return principal.userId;
}

/** The projects a token is fenced to, or null where the principal is not a fenced token. */
export function patEffectiveProjectIds(principal: McpPrincipal): readonly string[] | null {
  if (principal.kind !== 'pat') return null;
  if (principal.boundProjectId) return [principal.boundProjectId];
  return principal.projectIds;
}

export async function loadVisibleProjectIdsForPrincipal(
  principal: McpPrincipal,
): Promise<string[]> {
  const ids = await loadVisibleProjectIds(principalUserId(principal));
  const allow = patEffectiveProjectIds(principal);
  if (allow === null) return ids;
  const allowSet = new Set(allow);
  return ids.filter((id) => allowSet.has(id));
}

/** The REST refusal body, flagged `isError`, so both doors answer one shape. */
export function refusedAnswer(
  refusals: readonly Refusal[],
  fallbackCode: string,
): RefusalEnvelope & { _mcpIsError: true } {
  return { _mcpIsError: true, ...refusalEnvelope(refusals, fallbackCode) };
}
