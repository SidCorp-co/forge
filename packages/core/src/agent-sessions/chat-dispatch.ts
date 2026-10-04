// A chat turn on a session: decorate the message, persist the turn, and hand it to the box.
import { randomUUID } from 'node:crypto';
import {
  CONTENT_LANGUAGE_KEY,
  type ContentLanguageView,
  contentLanguageBlock,
  contentLanguageRecord,
} from '@forge/contracts/content-language';
import { isSlashCommandSkillName } from '@forge/contracts/skills';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, type MemberLens, type ModelTier, memberLenses } from '../db/schema.js';
import { resolveSessionRepoPathForDevice } from '../lib/device-pool.js';
import type { RefusalError } from '../lib/refusal.js';
import { deviceRoom, projectRoom, roomManager } from '../lib/rooms.js';
import { type KernelActor, movedRow } from '../lifecycle/index.js';
import { listSessionAttachmentsByIds, type SessionAttachmentRef } from './attachment-service.js';
import { applyAutoTitleAsync } from './auto-title.js';
import { broadcastSession, broadcastTurnAppended } from './broadcast.js';
import type { ChatClient } from './chat-turn.js';
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

export interface DispatchChatTurnArgs {
  /** The current session row (may be an empty `idle` placeholder). */
  session: AgentSessionRow;
  /** Loaded project — `slug` feeds the WS payload. */
  project: { id: string; slug: string };
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
export function checkoutUnbound(projectId: string, deviceId: string | null): RefusalError {
  return refuseSession(
    'CHECKOUT_UNBOUND',
    `device ${deviceId ?? '(none)'}'s binding to project ${projectId} names no checkout, so no turn runs there. The binding is the only place a checkout is named: set it with \`forge-runner bind <slug> --path <dir>\` on the box, or PATCH /api/projects/${projectId}/runners/:runnerId { repoPath }.`,
  );
}

/** The user text with the `[Context: …]` line prepended when the page or issue changed since the last turn. */
function decorateMessage(session: AgentSessionRow, args: DispatchChatTurnArgs): string {
  const prev = readPersistedPageContext(
    (session.metadata as { pageContext?: unknown } | null)?.pageContext,
  );
  if (!args.pageContext || samePageContext(prev, args.pageContext)) return args.message;
  return `${formatPageContextLine(args.pageContext)}\n${args.message}`;
}

interface TurnPlan {
  decorated: string;
  repoPath: string | null;
  attachments: SessionAttachmentRef[];
  prevMessages: Array<{ type?: string; content?: unknown }>;
  userMessage: Record<string, unknown>;
  messages: unknown[];
  claudeSessionId: string | null;
  resumable: boolean;
  model: ReturnType<typeof readSessionModel>;
  language: ContentLanguageView | null;
  now: Date;
}

async function planTurn(args: DispatchChatTurnArgs): Promise<TurnPlan> {
  const { session, project, client } = args;
  const { deviceId, isLocal } = client;
  const migrated = !!client.migrated;
  if (args.credential && isLocal) {
    throw new Error(
      `dispatchChatTurn: session ${session.id} was handed a turn credential on a local turn, which no runner receives, so it would be dropped`,
    );
  }
  if (args.skillName && !isSlashCommandSkillName(args.skillName)) {
    throw new Error(`dispatchChatTurn: invalid skillName '${args.skillName}'`);
  }
  const deviceChanged = !!deviceId && (migrated || deviceId !== (session.deviceId ?? null));
  let repoPath = session.repoPath ?? null;
  if (!repoPath || deviceChanged)
    repoPath = await resolveSessionRepoPathForDevice(project.id, deviceId);
  if (!isLocal && !repoPath) throw checkoutUnbound(project.id, deviceId);

  // attachment ids not belonging to this session drop here, before the turn persists them
  const attachments = args.attachmentIds?.length
    ? await listSessionAttachmentsByIds(session.id, args.attachmentIds)
    : [];
  const decorated = decorateMessage(session, args);
  const now = new Date();
  const prevMessages = Array.isArray(session.messages) ? session.messages : [];
  const userMessage: Record<string, unknown> = {
    id: randomUUID(),
    type: 'user',
    content: decorated,
    timestamp: now.getTime(),
    ...(attachments.length ? { attachments } : {}),
  };
  const claudeSessionId = args.claudeSessionId ?? session.claudeSessionId ?? null;
  const resumable = !!claudeSessionId && !migrated;
  // a cold start is where core writes the prompt, so it is where the session is told its
  // project's content language and records it; a resumed or pre-built turn keeps what it was told
  const language =
    !resumable && !isLocal && !args.preBuilt
      ? await agentSessionsPorts().readContentLanguage(project.id)
      : null;
  return {
    decorated,
    repoPath,
    attachments,
    prevMessages,
    userMessage,
    messages: [...prevMessages, userMessage],
    claudeSessionId,
    resumable,
    model:
      args.model === undefined ? readSessionModel(session.metadata) : (args.model ?? 'default'),
    language,
    now,
  };
}

/** The row patch a turn writes, and the fallback title when this is the session's first turn. */
function turnPatch(
  args: DispatchChatTurnArgs,
  plan: TurnPlan,
): { updates: AgentSessionPatch; fallbackTitle: string | null } {
  const { session, client } = args;
  const { deviceId, isLocal } = client;
  const updates: AgentSessionPatch = {
    messages: plan.messages,
    lastHeartbeatAt: plan.now,
    updatedAt: plan.now,
    startedAt: session.startedAt ?? plan.now,
    failureReason: null,
    repoPath: plan.repoPath,
  };
  if (deviceId && session.deviceId !== deviceId) updates.deviceId = deviceId;
  if (client.migrated) updates.claudeSessionId = null;
  const meta: Record<string, unknown> = {
    ...((session.metadata ?? {}) as Record<string, unknown>),
  };
  if (deviceId) meta.deviceId = deviceId;
  if (args.model !== undefined) meta.model = args.model ?? 'default';
  if (args.pageContext) meta.pageContext = args.pageContext;
  if (plan.language) {
    meta[CONTENT_LANGUAGE_KEY] = contentLanguageRecord(
      plan.language,
      'chat',
      plan.language.revision,
    );
  }
  if (!plan.resumable && !isLocal && args.skillName) {
    meta.pendingSkillName = args.skillName;
    meta.pendingSkillBaselineCount = plan.messages.length;
  }
  updates.metadata = meta;
  let fallbackTitle: string | null = null;
  if (plan.prevMessages.length === 0 && isPlaceholderTitle(session.title)) {
    fallbackTitle = deriveChatTitle(stripSystemNoise(args.message)) || null;
    if (fallbackTitle) updates.title = fallbackTitle;
  }
  return { updates, fallbackTitle };
}

/** Writes the turn, moves the session to running and seeds its turn rows, in one transaction. */
async function persistTurn(args: DispatchChatTurnArgs, plan: TurnPlan, updates: AgentSessionPatch) {
  const { session } = args;
  return db.transaction(async (tx) => {
    const [written] = await tx
      .update(agentSessions)
      .set(updates)
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
    const updated = { ...written, status: 'running' as const };
    const sync = await syncTurnsWithMessages(updated.id, plan.prevMessages, plan.messages, tx);
    const seeded = await seedTurn(tx, updated.id, {
      priorMessages: plan.prevMessages,
      entry: plan.userMessage,
      at: plan.now,
    });
    return { updated, sync, eventSeqBase: seeded.lastSeq };
  });
}

/** A cold start carries the preamble, the content language and, after a migration, the prior transcript. */
async function coldStartPrompt(args: DispatchChatTurnArgs, plan: TurnPlan): Promise<string> {
  let prompt = plan.decorated;
  if (!args.preBuilt) {
    const languageSection = plan.language
      ? `${contentLanguageBlock(plan.language, 'chat')}\n\n---\n\n`
      : '';
    prompt = languageSection + plan.decorated;
    try {
      const preamble = await agentSessionsPorts().buildChatPreamble(
        args.project.id,
        args.session.userId,
        args.forceLenses ?? readLensOverride(args.session.metadata),
      );
      prompt =
        preamble + languageSection + buildRehydrationBlock(plan.prevMessages) + plan.decorated;
    } catch {
      // non-fatal: proceed with the raw prompt and its language block
    }
  }
  // the slash-command goes on line 1, as a pipeline job's prompt carries it; a resumed turn never re-prepends it
  return args.skillName ? `/${args.skillName}\n${prompt}` : prompt;
}

/** Hands the turn to its box: `agent:start` on a cold start, `agent:send` on a resume. */
async function publishRemoteTurn(
  args: DispatchChatTurnArgs,
  plan: TurnPlan,
  updated: AgentSessionRow,
  eventSeqBase: number,
): Promise<void> {
  const { project } = args;
  const { mcpServers: mcpServersOverride } = await agentSessionsPorts().resolveSessionMcpServers(
    project.id,
  );
  const common = {
    sessionId: updated.id,
    eventSeqBase,
    repoPath: plan.repoPath,
    projectSlug: project.slug,
    mcpServersOverride,
    ...(plan.model ? { model: plan.model } : {}),
    ...(plan.attachments.length ? { attachments: plan.attachments } : {}),
    ...(args.credential ? { forgeToken: args.credential } : {}),
  };
  const room = deviceRoom(args.client.deviceId as string);
  if (!plan.resumable) {
    roomManager.publish(room, {
      event: 'agent:start',
      data: {
        ...common,
        prompt: await coldStartPrompt(args, plan),
        preBuilt: args.preBuilt ?? false,
        systemPrompt: agentSessionsPorts().toolReference(),
      },
    });
    return;
  }
  // --resume keeps the original system prompt and history
  roomManager.publish(room, {
    event: 'agent:send',
    data: { ...common, message: plan.decorated, claudeSessionId: plan.claudeSessionId },
  });
}

export async function dispatchChatTurn(args: DispatchChatTurnArgs): Promise<AgentSessionRow> {
  const broadcastEvent = args.broadcastEvent ?? 'agent-session.updated';
  const plan = await planTurn(args);
  const { updates, fallbackTitle } = turnPatch(args, plan);
  const { updated, sync, eventSeqBase } = await persistTurn(args, plan, updates);
  for (const t of sync.appended) broadcastTurnAppended(updated, t);
  // the AI title upgrade runs outside the transaction and is never awaited
  if (fallbackTitle) {
    void applyAutoTitleAsync({ sessionId: updated.id, userMessage: args.message, fallbackTitle });
  }
  if (args.client.isLocal) {
    roomManager.publish(projectRoom(args.project.id), {
      event: 'agent:user-message',
      data: {
        sessionId: updated.id,
        content: plan.decorated,
        ...(plan.attachments.length ? { attachments: plan.attachments } : {}),
      },
    });
  } else {
    await publishRemoteTurn(args, plan, updated, eventSeqBase);
  }
  broadcastSession(updated, broadcastEvent);
  return updated;
}
