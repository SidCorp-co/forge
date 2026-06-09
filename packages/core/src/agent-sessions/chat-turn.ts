import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { agentSessions, devices } from '../db/schema.js';
import { TOOL_REFERENCE, buildChatPreamble } from '../lib/chat-preamble.js';
import {
  findAvailableDeviceForProject,
  resolveRepoPath,
  resolveRunnerRepoPath,
} from '../lib/device-pool.js';
import { openOneShotRun } from '../pipeline/runs.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { broadcastSession, broadcastTurnAppended } from './broadcast.js';
import {
  type PageContext,
  formatPageContextLine,
  readPersistedPageContext,
  samePageContext,
} from './page-context.js';
import { syncTurnsWithMessages } from './turns-helpers.js';

// ============================================================================
// ONE logic for ONE purpose: delivering an interactive chat turn to a Claude
// client. Every entry point — POST /start, POST /send, and schedule.run — flows
// through this module so device selection, turn persistence, and the
// `agent:start` / `agent:send` WS dispatch live in exactly one place. Adding a
// fourth caller (or a missing one, the bug this replaced) cannot drift.
//
// Two genuinely different execution models share the dispatcher:
//   - REMOTE (web / schedule): core picks an online runner and publishes the
//     turn into its device room; the runner runs `claude` and streams back.
//   - LOCAL (desktop, origin='desktop'): the desktop runs `claude` itself and
//     streams via /relay — core only records the turn and mirrors it to web
//     viewers. No device pick, no `agent:start`.
// ============================================================================

type AgentSessionRow = typeof agentSessions.$inferSelect;

/**
 * The 409 a caller throws when a REMOTE chat turn has no online Claude client.
 * `scope` only changes the user-facing wording (a brand-new turn references the
 * project; a follow-up references the session) — same code `NO_CLAUDE_CLIENT`.
 */
export const noClaudeClient = (scope: 'project' | 'session') =>
  new HTTPException(409, {
    message:
      scope === 'project'
        ? 'No online Claude client for this project. Open the desktop app or bring a chat-capable runner online, then try again.'
        : 'No online Claude client for this session. Open the desktop app or bring its runner online, then try again.',
    cause: { code: 'NO_CLAUDE_CLIENT' },
  });

export interface ChatClient {
  /** Resolved runner device for a REMOTE turn; null when local, or none online. */
  deviceId: string | null;
  /** Desktop runs Claude locally — no device pick, no `agent:start` dispatch. */
  isLocal: boolean;
}

/**
 * Resolve which Claude client handles a chat turn for `session`.
 *
 * - origin='desktop' → local (the desktop runs Claude itself); deviceId=null.
 * - otherwise (web / schedule) → reuse the session's already-pinned device IF it
 *   is still online; else (no pin, or the pin went offline) pick the freshest
 *   online runner via `findAvailableDeviceForProject`. Verifying the pin is what
 *   keeps ISS-420 (don't dispatch to a dead device) — but instead of 409-ing on
 *   a stale pin we self-heal to a live runner, so only a truly empty pool fails.
 *
 * Never throws and never persists. The caller decides what a null REMOTE device
 * means — an HTTP 409 (`noClaudeClient`) for /start + /send, a `skipped` cron
 * result for schedules — and `dispatchChatTurn` persists a freshly-picked pin.
 */
export async function resolveChatDevice(
  session: Pick<AgentSessionRow, 'projectId' | 'deviceId' | 'metadata'>,
  origin?: string | null,
): Promise<ChatClient> {
  if (origin === 'desktop') return { deviceId: null, isLocal: true };
  const pinned =
    ((session.metadata ?? {}) as { deviceId?: string }).deviceId ?? session.deviceId ?? null;
  if (pinned) {
    const [dev] = await db
      .select({ status: devices.status })
      .from(devices)
      .where(eq(devices.id, pinned))
      .limit(1);
    if (dev?.status === 'online') return { deviceId: pinned, isLocal: false };
  }
  const deviceId = await findAvailableDeviceForProject(session.projectId);
  return { deviceId, isLocal: false };
}

export interface CreateChatSessionArgs {
  projectId: string;
  userId: string | null;
  title?: string | null;
  deviceId?: string | null;
  repoPath?: string | null;
  claudeSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Run kind for the one-shot pipeline_run every session belongs to (ISS-101). */
  runKind?: 'interactive' | 'system';
  runMetadata?: Record<string, unknown>;
}

/**
 * Insert an EMPTY chat session row (no seed turn, status defaults to `idle`).
 * The first turn is delivered later through {@link dispatchChatTurn}, exactly
 * like a follow-up — that uniformity is what collapses "begin a chat" and
 * "continue a chat" into one dispatch path.
 */
export async function createChatSessionRow(args: CreateChatSessionArgs): Promise<AgentSessionRow> {
  const run = await openOneShotRun({
    projectId: args.projectId,
    kind: args.runKind ?? 'interactive',
    ...(args.runMetadata ? { metadata: args.runMetadata } : {}),
  });
  const [row] = await db
    .insert(agentSessions)
    .values({
      projectId: args.projectId,
      userId: args.userId,
      deviceId: args.deviceId ?? null,
      pipelineRunId: run.id,
      title: args.title ?? null,
      repoPath: args.repoPath ?? null,
      claudeSessionId: args.claudeSessionId ?? null,
      metadata: (args.metadata ?? null) as never,
    })
    .returning();
  if (!row) throw new Error('agent_sessions: insert returned no row');
  return row;
}

export interface DispatchChatTurnArgs {
  /** The current session row (may be an empty `idle` placeholder). */
  session: AgentSessionRow;
  /** Loaded project — `slug` + `repoPath` feed the WS payload / cwd fallback. */
  project: { id: string; slug: string; repoPath: string | null };
  /** Client resolved by {@link resolveChatDevice}; caller has already 409'd / skipped on a null remote device. */
  client: ChatClient;
  /** Raw user text / prompt (NOT pre-decorated — this fn prepends [Context: …]). */
  message: string;
  origin?: string | null;
  pageContext?: PageContext | null;
  /** /send may carry the client's claudeSessionId; falls back to the row's. */
  claudeSessionId?: string | null;
  /** /start passes prompts that already embed the preamble (skip rebuilding it). */
  preBuilt?: boolean;
  /**
   * Which session event to broadcast. A freshly-created session (/start,
   * schedule) wants `agent-session.created` so web inserts it into the list; a
   * follow-up (/send) wants `agent-session.updated`. Default: updated.
   */
  broadcastEvent?: 'agent-session.created' | 'agent-session.updated';
}

/**
 * Append one user turn to a session and dispatch it to its Claude client.
 *
 * Decides `agent:start` vs `agent:send` purely from whether a Claude session id
 * exists yet: no id → first turn → `agent:start` (system prompt + chat
 * preamble); id present → follow-up → `agent:send` (`--resume`). A web cold
 * start (empty session, first /send) therefore correctly starts a fresh Claude
 * session instead of 409-ing on a pin nobody ever set.
 */
export async function dispatchChatTurn(args: DispatchChatTurnArgs): Promise<AgentSessionRow> {
  const { session, project, client, origin } = args;
  const { deviceId, isLocal } = client;
  const broadcastEvent = args.broadcastEvent ?? 'agent-session.updated';

  // Re-prepend the [Context: …] header only when the user switched page/issue
  // since the previous turn. A brand-new session has no prior context, so its
  // first turn always gets the header (matches the legacy /start behaviour).
  const prevMeta = (session.metadata ?? {}) as Record<string, unknown> & { pageContext?: unknown };
  const lastPageContext = readPersistedPageContext(prevMeta.pageContext);
  const shouldPrepend = !!args.pageContext && !samePageContext(lastPageContext, args.pageContext);
  const decoratedMessage = shouldPrepend
    ? `${formatPageContextLine(args.pageContext as PageContext)}\n${args.message}`
    : args.message;

  // cwd for `claude` runs on the chosen runner's box → prefer that runner's
  // binding path; the project default is only valid on the owner's own machine
  // (correct for the desktop, which has no binding). Resolve once, when unset.
  let repoPath = session.repoPath ?? null;
  if (!repoPath) {
    const bindingRepo = deviceId ? await resolveRunnerRepoPath(project.id, deviceId) : null;
    repoPath = resolveRepoPath(null, bindingRepo ?? project.repoPath ?? null);
  }

  const prevMessages = Array.isArray(session.messages) ? session.messages : [];
  const now = new Date();
  const userMessage = { role: 'user', content: decoratedMessage, timestamp: now.getTime() };
  const messages = [...prevMessages, userMessage];

  const updates: Record<string, unknown> = {
    messages: messages as never,
    status: 'running',
    lastHeartbeatAt: now,
    updatedAt: now,
    startedAt: session.startedAt ?? now,
    failureReason: null,
    repoPath,
  };
  // Pin the freshly-picked device so the next /send reuses it.
  if (deviceId && session.deviceId !== deviceId) updates.deviceId = deviceId;
  const nextMeta = { ...prevMeta };
  if (deviceId) nextMeta.deviceId = deviceId;
  if (args.pageContext) nextMeta.pageContext = args.pageContext;
  updates.metadata = nextMeta;

  const { updated, sync } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentSessions)
      .set(updates)
      .where(eq(agentSessions.id, session.id))
      .returning();
    if (!row) throw new Error('agent_sessions: update returned no row');
    // Materialize the appended user turn in the same transaction so the legacy
    // blob and per-turn rows can never diverge if the turn insert throws.
    const s = await syncTurnsWithMessages(row.id, prevMessages, messages, tx);
    return { updated: row, sync: s };
  });
  for (const t of sync.appended) broadcastTurnAppended(updated, t);

  if (isLocal) {
    // Desktop runs Claude locally — just mirror the user turn to web viewers.
    roomManager.publish(projectRoom(project.id), {
      event: 'agent:user-message',
      data: { sessionId: updated.id, content: decoratedMessage },
    });
    broadcastSession(updated, broadcastEvent);
    return updated;
  }

  const target = deviceId as string;
  const claudeSessionId = args.claudeSessionId ?? session.claudeSessionId ?? null;
  if (!claudeSessionId) {
    // First turn — fresh Claude session: carry the tool reference + project preamble.
    let prompt = decoratedMessage;
    if (!args.preBuilt) {
      try {
        prompt = (await buildChatPreamble(project.id)) + decoratedMessage;
      } catch {
        // non-fatal — proceed with the raw prompt
      }
    }
    roomManager.publish(deviceRoom(target), {
      event: 'agent:start',
      data: {
        sessionId: updated.id,
        repoPath,
        prompt,
        projectSlug: project.slug,
        preBuilt: args.preBuilt ?? false,
        systemPrompt: TOOL_REFERENCE,
      },
    });
  } else {
    // Follow-up — `--resume` keeps the original system prompt + history.
    roomManager.publish(deviceRoom(target), {
      event: 'agent:send',
      data: {
        sessionId: updated.id,
        message: decoratedMessage,
        claudeSessionId,
        repoPath,
        projectSlug: project.slug,
      },
    });
  }
  broadcastSession(updated, broadcastEvent);
  return updated;
}
