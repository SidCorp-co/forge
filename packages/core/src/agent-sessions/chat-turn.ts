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
import { resolveProjectDefaultMcpServers } from '../jobs/stage-overrides.js';
import { openOneShotRun } from '../pipeline/runs.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import {
  type SessionAttachmentRef,
  listSessionAttachmentsByIds,
} from './attachment-service.js';
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
 * Derive a session title from the first user message (ISS-462): collapse all
 * whitespace/newlines to single spaces, trim, cap at 80 chars (ellipsised).
 * Returns '' for blank input so the caller can skip titling. Always fed the
 * RAW user text — never the `[Context: …]`-decorated prompt.
 */
export function deriveChatTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

/**
 * A session title is "placeholder" when it carries no human-meaningful value —
 * null/blank, or the literal "Chat" the web bootstrap used to stamp on create.
 * Auto-titling only ever replaces a placeholder, so a user-renamed session
 * (or a fork/rerun derived title) is never clobbered.
 */
function isPlaceholderTitle(title: string | null | undefined): boolean {
  const t = title?.trim();
  return !t || t === 'Chat';
}

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
  /**
   * True when we had to pick a device OTHER than the session's existing pin
   * (the pin went offline/disabled). The Claude on-disk session (`--resume`
   * target) lives only on the OLD box, so a follow-up turn must NOT `--resume`
   * here — it cold-starts on the new device and rehydrates history from the DB
   * transcript instead. Undefined ≡ false (a brand-new session has no pin to
   * lose, so it is a genuine cold start, not a migration).
   */
  migrated?: boolean;
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
 *   When the self-heal lands on a DIFFERENT device than the pin, `migrated` is
 *   set so the dispatcher rehydrates from DB history instead of issuing a
 *   `--resume` against a session file that does not exist on the new box.
 *
 * Never throws and never persists. The caller decides what a null REMOTE device
 * means — an HTTP 409 (`noClaudeClient`) for /start + /send, a `skipped` cron
 * result for schedules — and `dispatchChatTurn` persists a freshly-picked pin.
 */
export async function resolveChatDevice(
  session: Pick<AgentSessionRow, 'projectId' | 'deviceId' | 'metadata'>,
  origin?: string | null,
): Promise<ChatClient> {
  if (origin === 'desktop') return { deviceId: null, isLocal: true, migrated: false };
  const pinned =
    ((session.metadata ?? {}) as { deviceId?: string }).deviceId ?? session.deviceId ?? null;
  if (pinned) {
    const [dev] = await db
      .select({ status: devices.status, disabledAt: devices.disabledAt })
      .from(devices)
      .where(eq(devices.id, pinned))
      .limit(1);
    // A turned-off device is ignored even when online + pinned — fall through to
    // pick another available device (or report no client).
    if (dev?.status === 'online' && !dev.disabledAt)
      return { deviceId: pinned, isLocal: false, migrated: false };
  }
  const deviceId = await findAvailableDeviceForProject(session.projectId);
  // Migration = we had a pin but could not honour it and landed on another live
  // device. A pinless session is a true cold start, not a migration.
  const migrated = !!pinned && !!deviceId && deviceId !== pinned;
  return { deviceId, isLocal: false, migrated };
}

/**
 * Cap on how much prior transcript we re-inject when a session migrates to a new
 * runner. The full conversation lives in the DB; we replay the tail (newest
 * turns first, then chronological) up to this many characters so the cold-start
 * prompt primes Claude without blowing the context window on a long history.
 */
const MAX_REHYDRATION_CHARS = 12_000;

/**
 * Build a transcript block that re-establishes prior context after a session
 * migrates to a different runner (the on-disk `--resume` state is unreachable).
 * Returns '' when there is no prior history (a genuine cold start).
 */
export function buildRehydrationBlock(
  prev: ReadonlyArray<{ role?: string; content?: unknown }>,
): string {
  if (!prev.length) return '';
  const kept: string[] = [];
  let total = 0;
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i];
    if (!m) continue;
    const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : (m.role ?? '?');
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    const line = `${role}: ${content}`;
    // Always keep at least the newest turn even if it alone exceeds the budget.
    if (kept.length && total + line.length > MAX_REHYDRATION_CHARS) break;
    kept.push(line);
    total += line.length;
  }
  kept.reverse();
  return (
    '[Your previous session was resumed on a different machine; its local ' +
    'context is unavailable. The prior conversation transcript follows — treat ' +
    'it as the established history and continue seamlessly.]\n\n' +
    `${kept.join('\n\n')}\n\n` +
    '[End of prior transcript. Continue with the new message below.]\n\n'
  );
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
  /**
   * ISS-499 — ids of session attachments (uploaded via POST
   * /agent-sessions/:id/attachments) to attach to THIS turn. Hydrated to refs,
   * stamped on the persisted user message (re-render) and sent to the runner in
   * the WS frame so it can auth-download + feed them to claude.
   */
  attachmentIds?: string[] | undefined;
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
 * Decides `agent:start` vs `agent:send` from whether the turn is *resumable* —
 * a Claude session id exists AND the client did not migrate to a new device.
 *   - no id (first turn)        → `agent:start` (system prompt + chat preamble)
 *   - id + same device          → `agent:send` (`--resume`, fast path)
 *   - id + migrated to new box  → `agent:start` with the DB transcript rehydrated
 *     (the old `--resume` file is unreachable on the new runner)
 * A web cold start (empty session, first /send) therefore correctly starts a
 * fresh Claude session instead of 409-ing on a pin nobody ever set.
 */
export async function dispatchChatTurn(args: DispatchChatTurnArgs): Promise<AgentSessionRow> {
  const { session, project, client, origin } = args;
  const { deviceId, isLocal } = client;
  const migrated = !!client.migrated;
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

  // ISS-499 — hydrate attachment refs (drops ids not belonging to this session)
  // BEFORE building the user message so they persist on the turn for re-render.
  const attachments: SessionAttachmentRef[] = args.attachmentIds?.length
    ? await listSessionAttachmentsByIds(session.id, args.attachmentIds)
    : [];

  const prevMessages = Array.isArray(session.messages) ? session.messages : [];
  const now = new Date();
  const userMessage = {
    role: 'user',
    content: decoratedMessage,
    timestamp: now.getTime(),
    ...(attachments.length ? { attachments } : {}),
  };
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
  // On migration the old Claude session id points at a file on the dead box —
  // drop it so this turn cold-starts here and the new runner stamps a fresh id
  // (which the next follow-up will `--resume` against this device).
  if (migrated) updates.claudeSessionId = null;
  const nextMeta = { ...prevMeta };
  if (deviceId) nextMeta.deviceId = deviceId;
  if (args.pageContext) nextMeta.pageContext = args.pageContext;
  updates.metadata = nextMeta;

  // Auto-title a brand-new, still-untitled session from its first user message
  // (ISS-462) so the history switcher can tell conversations apart instead of
  // showing a wall of "Chat". Strict guard — FIRST turn only AND title still a
  // placeholder — so a follow-up turn or a user-renamed session is never
  // overwritten. Uses the RAW message (not `decoratedMessage`) to keep the
  // `[Context: …]` header out of the title.
  if (prevMessages.length === 0 && isPlaceholderTitle(session.title)) {
    const derived = deriveChatTitle(args.message);
    if (derived) updates.title = derived;
  }

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
      data: {
        sessionId: updated.id,
        content: decoratedMessage,
        ...(attachments.length ? { attachments } : {}),
      },
    });
    broadcastSession(updated, broadcastEvent);
    return updated;
  }

  const target = deviceId as string;
  // Seed the project-default MCP servers (e.g. playwright) into every chat turn.
  // Each turn re-spawns `claude` with a fresh `--mcp-config`, so the follow-up
  // (`agent:send`) needs it as much as the cold start. Best-effort: returns `{}`
  // (harmless) when the project has no `pipelineConfig.mcpServers` configured.
  const mcpServersOverride = await resolveProjectDefaultMcpServers(project.id);
  const claudeSessionId = args.claudeSessionId ?? session.claudeSessionId ?? null;
  // Resume only when we have a Claude session id AND we are still on the device
  // that owns it. A migration breaks resume affinity → cold-start + rehydrate.
  const resumable = !!claudeSessionId && !migrated;
  if (!resumable) {
    // Cold start — fresh Claude session: carry the tool reference + project
    // preamble. On a migration, re-inject the prior transcript from the DB so
    // the new runner continues the conversation without the on-disk --resume
    // state (the unlock: history lives in the DB, not only on the old box).
    let prompt = decoratedMessage;
    if (!args.preBuilt) {
      try {
        const preamble = await buildChatPreamble(project.id);
        const history = migrated ? buildRehydrationBlock(prevMessages) : '';
        prompt = preamble + history + decoratedMessage;
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
        mcpServersOverride,
        ...(attachments.length ? { attachments } : {}),
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
        mcpServersOverride,
        ...(attachments.length ? { attachments } : {}),
      },
    });
  }
  broadcastSession(updated, broadcastEvent);
  return updated;
}
