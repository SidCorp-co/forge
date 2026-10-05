import { randomUUID } from 'node:crypto';
import {
  CONTENT_LANGUAGE_KEY,
  type ContentLanguageView,
  contentLanguageBlock,
  contentLanguageRecord,
} from '@forge/contracts/content-language';
import { isSlashCommandSkillName } from '@forge/contracts/skills';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  agentSessions,
  devices,
  type MemberLens,
  type ModelTier,
  memberLenses,
} from '../db/schema.js';
import {
  findAvailableDeviceForProject,
  findChatCapableDeviceForProject,
  resolveSessionRepoPathForDevice,
} from '../lib/device-pool.js';
import { logger } from '../lib/logger.js';
import type { RefusalError } from '../lib/refusal.js';
import { deviceRoom, roomManager } from '../lib/rooms.js';
import { type KernelActor, movedRow } from '../lifecycle/index.js';
import { assertRunAcceptsWork, insertOneShotRun, openOneShotRun } from '../pipeline/index.js';
import { listSessionAttachmentsByIds, type SessionAttachmentRef } from './attachment-service.js';
import { applyAutoTitleAsync } from './auto-title.js';
import { broadcastSession, broadcastTurnAppended } from './broadcast.js';
import { stripSystemNoise } from './content-filter.js';
import {
  formatPageContextLine,
  type PageContext,
  readPersistedPageContext,
  samePageContext,
} from './page-context.js';
import { agentSessionsPorts } from './ports.js';
import { refuseSession } from './refusals.js';
import { seedTurn } from './session-events.js';
import type { AgentSessionPatch } from './session-failure.js';
import { readSessionModel } from './session-model.js';
import { transitionSessions } from './session-transition.js';
import { syncTurnsWithMessages } from './turns-helpers.js';

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

function isPlaceholderTitle(title: string | null | undefined): boolean {
  const t = title?.trim();
  return !t || t === 'Chat';
}

function readLensOverride(metadata: unknown): MemberLens[] | null {
  const value = (metadata as { lensOverride?: unknown } | null)?.lensOverride;
  if (!Array.isArray(value)) return null;
  const known = new Set<string>(memberLenses);
  return value.filter((l): l is MemberLens => typeof l === 'string' && known.has(l));
}

/**
 * The refusal a caller throws when a REMOTE chat turn has no online Claude client.
 * `scope` only changes the user-facing wording (a brand-new turn references the
 * project; a follow-up references the session) — same code `NO_CLAUDE_CLIENT`.
 */
export const noClaudeClient = (scope: 'project' | 'session' | 'picked') =>
  refuseSession(
    'NO_CLAUDE_CLIENT',
    scope === 'project'
      ? 'No online Claude client for this project. Bring a chat-capable runner online, then try again.'
      : scope === 'picked'
        ? 'The selected runner is offline or not chat-capable for this project. Pick another runner, choose Auto, or bring it online, then try again.'
        : 'No online Claude client for this session. Bring its runner online, then try again.',
  );

export interface ChatClient {
  /** The runner device the turn goes to; null when none is online. */
  deviceId: string | null;
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

export async function resolveChatDevice(
  session: Pick<AgentSessionRow, 'projectId' | 'deviceId' | 'metadata'>,
  overrideDeviceId?: string | null,
  /** Only a box whose heartbeat declared this capability `true` is picked. */
  requireCapability?: string,
): Promise<ChatClient> {
  const need = requireCapability ? { requireCapability } : {};
  const pinned =
    ((session.metadata ?? {}) as { deviceId?: string }).deviceId ?? session.deviceId ?? null;
  if (overrideDeviceId) {
    const picked = await findChatCapableDeviceForProject(session.projectId, overrideDeviceId, {
      allowLimited: true,
      ...need,
    });
    if (!picked) return { deviceId: null, migrated: false };
    return { deviceId: picked, migrated: !!pinned && picked !== pinned };
  }
  if (pinned) {
    const capable = await findChatCapableDeviceForProject(session.projectId, pinned, need);
    if (capable) return { deviceId: capable, migrated: false };
    const liveButLimited = await findChatCapableDeviceForProject(session.projectId, pinned, {
      allowLimited: true,
      ...need,
    });
    if (!liveButLimited) {
      const [dev] = await db
        .select({
          status: devices.status,
          disabledAt: devices.disabledAt,
          capabilities: devices.capabilities,
        })
        .from(devices)
        .where(eq(devices.id, pinned))
        .limit(1);
      const declares =
        !requireCapability ||
        (dev?.capabilities as Record<string, unknown> | null)?.[requireCapability] === true;
      // A turned-off device is ignored even when online + pinned — fall through to
      // pick another available device (or report no client).
      if (dev?.status === 'online' && !dev.disabledAt && declares)
        return { deviceId: pinned, migrated: false };
    }
  }
  const deviceId = await findAvailableDeviceForProject(session.projectId, need);
  // Migration = we had a pin but could not honour it and landed on another live
  // device. A pinless session is a true cold start, not a migration.
  const migrated = !!pinned && !!deviceId && deviceId !== pinned;
  return { deviceId, migrated };
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
const TYPE_LABEL: Readonly<Record<string, string>> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool_use: 'Tool',
  tool_result: 'Tool',
};

export function buildRehydrationBlock(
  prev: ReadonlyArray<{ type?: string; content?: unknown }>,
): string {
  if (!prev.length) return '';
  const kept: string[] = [];
  let total = 0;
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i];
    if (!m) continue;
    const role = (m.type && TYPE_LABEL[m.type]) ?? m.type ?? '?';
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    const line = `${role}: ${content}`;
    // Always keep at least the newest turn even if it alone exceeds the budget.
    if (kept.length && total + line.length > MAX_REHYDRATION_CHARS) break;
    kept.push(line);
    total += line.length;
  }
  kept.reverse();
  return `[This is a cold start; the previous local process context is unavailable. The prior conversation transcript follows — treat it as the established history and continue seamlessly.]\n\n${kept.join('\n\n')}\n\n[End of prior transcript. Continue with the new message below.]\n\n`;
}

interface CreateChatSessionArgs {
  projectId: string;
  userId: string | null;
  title?: string | null;
  deviceId?: string | null;
  repoPath?: string | null;
  claudeSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** The session this one was cut from — a rerun's source, a failover's
   *  predecessor. Core's own record, never a caller's claim about a tree. */
  parentSessionId?: string | null;
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
  const metadata =
    args.runKind === 'system' ? { ...(args.metadata ?? {}), unattended: true } : args.metadata;
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
      kind: 'chat',
      parentSessionId: args.parentSessionId ?? null,
      metadata: (metadata ?? null) as never,
    })
    .returning();
  if (!row) throw new Error('agent_sessions: insert returned no row');
  return row;
}

export interface DispatchChatTurnArgs {
  /** The current session row (may be an empty `idle` placeholder). */
  session: AgentSessionRow;
  /** Loaded project — `slug` feeds the WS payload. */
  project: { id: string; slug: string };
  /** Client resolved by {@link resolveChatDevice}; caller has already 409'd / skipped on a null remote device. */
  client: ChatClient;
  /** Raw user text / prompt (NOT pre-decorated — this fn prepends [Context: …]). */
  message: string;
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
  forceLenses?: readonly MemberLens[] | null;
  /**
   * Which session event to broadcast. A freshly-created session (/start,
   * schedule) wants `agent-session.created` so web inserts it into the list; a
   * follow-up (/send) wants `agent-session.updated`. Default: updated.
   */
  broadcastEvent?: 'agent-session.created' | 'agent-session.updated';
  skillName?: string | null;
  model?: ModelTier | null | undefined;
  /**
   * The token this turn acts under in place of the box's own, minted for the person it answers
   * (`session-credential.ts`). A follow-up carries one too: the previous turn's was revoked when
   * that turn stopped, so the runner respawns the session under this one.
   */
  credential?: string | undefined;
  /** Who sent the turn, as the kernel records the session's move to `running`; absent, core. */
  actor?: KernelActor | undefined;
}

/** A remote turn runs in its device binding's checkout; a binding that names none is refused by name. */
function checkoutUnbound(projectId: string, deviceId: string | null): RefusalError {
  return refuseSession(
    'CHECKOUT_UNBOUND',
    `device ${deviceId ?? '(none)'}'s binding to project ${projectId} names no checkout, so no turn runs there. The binding is the only place a checkout is named: set it with \`forge-runner bind <slug> --path <dir>\` on the box, or PATCH /api/projects/${projectId}/runners/:runnerId { repoPath }.`,
  );
}

/**
 * A cold start carries the tool reference and project preamble; after a migration it also
 * re-injects the prior transcript, since the on-disk `--resume` state stayed on the old box.
 * ISS-733 — the slash-command goes on line 1, as a pipeline job's prompt carries it.
 */
async function coldStartPrompt(
  args: DispatchChatTurnArgs,
  decoratedMessage: string,
  language: ContentLanguageView | null,
  prevMessages: ReadonlyArray<{ type?: string; content?: unknown }>,
): Promise<string> {
  let prompt = decoratedMessage;
  if (!args.preBuilt) {
    const languageSection = language ? `${contentLanguageBlock(language, 'chat')}\n\n---\n\n` : '';
    const history = buildRehydrationBlock(prevMessages);
    let preamble = '';
    try {
      preamble = await agentSessionsPorts().buildChatPreamble(
        args.project.id,
        args.session.userId,
        args.forceLenses ?? readLensOverride(args.session.metadata),
      );
    } catch (err) {
      // the turn still runs, carrying its history and language, without the project preamble
      logger.error(
        { err, sessionId: args.session.id, projectId: args.project.id },
        'chat-turn: the project preamble could not be built; the cold start goes without it',
      );
    }
    prompt = preamble + languageSection + history + decoratedMessage;
  }
  return args.skillName ? `/${args.skillName}\n${prompt}` : prompt;
}

/**
 * The run a chat turn is written under, read FOR SHARE in the turn's transaction: the session's own
 * while it accepts work. A chat whose one-shot run already closed (the session ended, or a reaper
 * closed it) gets a fresh one-shot run of the same kind for this turn, so the follow-up is a new
 * run of work rather than a revival under a dead one. A session under any other run kind is refused
 * by name (`RUN_NOT_ACCEPTING_WORK`).
 */
async function liveRunFor(
  tx: Tx,
  session: Pick<AgentSessionRow, 'pipelineRunId' | 'projectId'>,
): Promise<string> {
  const runId = session.pipelineRunId;
  const [run] = (await tx.execute(
    sql`SELECT status, kind FROM pipeline_runs WHERE id = ${runId} FOR SHARE`,
  )) as unknown as Array<{ status: string; kind: string }>;
  if (!run || run.status === 'running' || run.status === 'paused') return runId;
  if (run.kind !== 'interactive' && run.kind !== 'system') {
    await assertRunAcceptsWork(tx, runId);
    return runId;
  }
  const next = await insertOneShotRun(tx, {
    projectId: session.projectId,
    kind: run.kind,
    metadata: { followsRun: runId },
  });
  return next.id;
}

export async function dispatchChatTurn(args: DispatchChatTurnArgs): Promise<AgentSessionRow> {
  const { session, project, client } = args;
  const { deviceId } = client;
  if (!deviceId) throw noClaudeClient('session');
  const migrated = !!client.migrated;
  const broadcastEvent = args.broadcastEvent ?? 'agent-session.updated';

  // The [Context: …] header goes first only when the user switched page/issue since the
  // previous turn; a brand-new session has none, so its first turn always gets it.
  const prevMeta = (session.metadata ?? {}) as Record<string, unknown> & { pageContext?: unknown };
  const decoratedMessage =
    !args.pageContext ||
    samePageContext(readPersistedPageContext(prevMeta.pageContext), args.pageContext)
      ? args.message
      : `${formatPageContextLine(args.pageContext)}\n${args.message}`;

  const deviceChanged = !!deviceId && (migrated || deviceId !== (session.deviceId ?? null));
  let repoPath = session.repoPath ?? null;
  if (!repoPath || deviceChanged)
    repoPath = await resolveSessionRepoPathForDevice(project.id, deviceId);
  if (!repoPath) throw checkoutUnbound(project.id, deviceId);
  // a turn no socket of the box would receive is refused before anything is written
  if (roomManager.roomSize(deviceRoom(deviceId)) === 0) throw noClaudeClient('session');

  const attachments: SessionAttachmentRef[] = args.attachmentIds?.length
    ? await listSessionAttachmentsByIds(session.id, args.attachmentIds)
    : [];

  const prevMessages = Array.isArray(session.messages) ? session.messages : [];
  const now = new Date();
  const userMessage: Record<string, unknown> = {
    id: randomUUID(),
    type: 'user',
    content: decoratedMessage,
    timestamp: now.getTime(),
    ...(attachments.length ? { attachments } : {}),
  };
  const messages = [...prevMessages, userMessage];

  // Resolved before the transaction so the ISS-733 `pendingSkillName` marker persists in it.
  const claudeSessionId = args.claudeSessionId ?? session.claudeSessionId ?? null;
  const resumable = !!claudeSessionId && !migrated;
  const model =
    args.model === undefined ? readSessionModel(session.metadata) : (args.model ?? 'default');
  if (args.skillName && !isSlashCommandSkillName(args.skillName)) {
    throw new Error(`dispatchChatTurn: invalid skillName '${args.skillName}'`);
  }

  // cm:why a cold start is where core writes the prompt, so it is where the session is told its
  // project's content language and records it; a resumed or pre-built turn keeps what it was told
  const language =
    !resumable && !args.preBuilt
      ? await agentSessionsPorts().readContentLanguage(project.id)
      : null;

  const updates: AgentSessionPatch = {
    messages,
    lastHeartbeatAt: now,
    updatedAt: now,
    startedAt: session.startedAt ?? now,
    failureReason: null,
    repoPath,
  };
  if (deviceId && session.deviceId !== deviceId) updates.deviceId = deviceId;
  if (migrated) updates.claudeSessionId = null;
  const nextMeta = { ...prevMeta };
  if (deviceId) nextMeta.deviceId = deviceId;
  if (args.model !== undefined) nextMeta.model = args.model ?? 'default';
  if (args.pageContext) nextMeta.pageContext = args.pageContext;
  if (language) {
    nextMeta[CONTENT_LANGUAGE_KEY] = contentLanguageRecord(language, 'chat', language.revision);
  }
  if (!resumable && args.skillName) {
    nextMeta.pendingSkillName = args.skillName;
    nextMeta.pendingSkillBaselineCount = messages.length;
  }
  updates.metadata = nextMeta;

  let fallbackTitle: string | null = null;
  if (prevMessages.length === 0 && isPlaceholderTitle(session.title)) {
    fallbackTitle = deriveChatTitle(stripSystemNoise(args.message)) || null;
    if (fallbackTitle) updates.title = fallbackTitle;
  }

  const { updated, sync, eventSeqBase } = await db.transaction(async (tx) => {
    const pipelineRunId = await liveRunFor(tx, session);
    const [written] = await tx
      .update(agentSessions)
      .set({ ...updates, pipelineRunId })
      .where(eq(agentSessions.id, session.id))
      .returning();
    if (!written) throw new Error('agent_sessions: update returned no row');
    if (written.status !== 'running') {
      movedRow(
        await transitionSessions(tx, {
          to: 'running',
          expect: written.status,
          where: eq(agentSessions.id, session.id),
          actor: args.actor ?? { type: 'system' },
          source: 'chat-turn',
          returning: ['id'],
        }),
      );
    }
    const row = { ...written, status: 'running' as const };
    // the legacy blob and the per-turn rows are written in one transaction so they never diverge
    const s = await syncTurnsWithMessages(row.id, prevMessages, messages, tx);
    const seeded = await seedTurn(tx, row.id, {
      priorMessages: prevMessages,
      entry: userMessage,
      at: now,
    });
    return { updated: row, sync: s, eventSeqBase: seeded.lastSeq };
  });
  for (const t of sync.appended) broadcastTurnAppended(updated, t);

  // the AI title upgrade runs outside the transaction and is never awaited
  if (fallbackTitle) {
    void applyAutoTitleAsync({ sessionId: updated.id, userMessage: args.message, fallbackTitle });
  }

  const { mcpServers: mcpServersOverride } = await agentSessionsPorts().resolveSessionMcpServers(
    project.id,
  );
  const common = {
    sessionId: updated.id,
    eventSeqBase,
    repoPath,
    projectSlug: project.slug,
    mcpServersOverride,
    ...(model ? { model } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(args.credential ? { forgeToken: args.credential } : {}),
  };
  const delivered = roomManager.publish(
    deviceRoom(deviceId),
    resumable
      ? // `--resume` keeps the original system prompt and history
        {
          event: 'agent:send',
          data: { ...common, message: decoratedMessage, claudeSessionId },
        }
      : {
          event: 'agent:start',
          data: {
            ...common,
            prompt: await coldStartPrompt(args, decoratedMessage, language, prevMessages),
            preBuilt: args.preBuilt ?? false,
            systemPrompt: agentSessionsPorts().toolReference(),
          },
        },
  );
  if (delivered === 0) {
    // the box's socket dropped between the check and the frame: the turn is failed, never left running
    await transitionSessions(db, {
      to: 'failed',
      set: { failureReason: 'no_client_ack', updatedAt: new Date() },
      where: eq(agentSessions.id, updated.id),
      reason: 'no_client_ack',
      actor: { type: 'system' },
      source: 'chat-turn',
    });
    throw noClaudeClient('session');
  }
  broadcastSession(updated, broadcastEvent);
  return updated;
}
