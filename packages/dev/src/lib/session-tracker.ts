/**
 * Shared session tracking: message merging + local persistence.
 *
 * Used by both useAgentChat (local flow) and use-web-socket (web flow)
 * so that session saving logic is consistent regardless of origin.
 */
import { invoke } from "@/hooks/use-tauri-ipc";
import { parseStreamMessages } from "./stream-parser";
import type { AgentMessage } from "./types";

const INCREMENTAL_FLUSH_INTERVAL_MS = 30_000;
const INCREMENTAL_FLUSH_MESSAGE_THRESHOLD = 5;

export interface SessionSnapshot {
  messages: AgentMessage[];
  claudeSessionId: string | null;
}

export interface SessionTrackerOptions {
  /** Called periodically with a snapshot of in-flight session state so the
   *  server-side `agent_sessions` row reflects pre-crash progress (ISS-84).
   *  Best-effort: failures are logged and swallowed. */
  remotePersist?: (agentSessionId: string, snapshot: SessionSnapshot) => Promise<void>;
}

/**
 * Merge parsed agent messages into an existing message list (mutates array).
 * Handles assistant continuation, tool_result attachment, and appending new messages.
 */
export function mergeMessages(messages: AgentMessage[], parsed: AgentMessage[]): void {
  for (const p of parsed) {
    const last = messages[messages.length - 1];

    if (p.type === "assistant" && last?.type === "assistant") {
      // Merge tool calls
      const oldTools = last.toolCalls ?? [];
      const newTools = p.toolCalls ?? [];
      const existingIds = new Set(oldTools.map((t) => t.id));
      const merged = [...oldTools, ...newTools.filter((t) => !existingIds.has(t.id))];

      // Merge content blocks
      const oldBlocks = last.blocks ?? [];
      const newBlocks = p.blocks ?? [];
      const existingToolIds = new Set(
        oldBlocks.filter((b) => b.type === "tool").map((b) => b.toolCall?.id),
      );
      const mergedBlocks = [
        ...oldBlocks,
        ...newBlocks.filter(
          (b) => b.type === "text" || (b.type === "tool" && !existingToolIds.has(b.toolCall?.id)),
        ),
      ];

      messages[messages.length - 1] = {
        ...p,
        toolCalls: merged.length > 0 ? merged : undefined,
        blocks: mergedBlocks.length > 0 ? mergedBlocks : undefined,
      };
    } else if (p.type === "tool_result" && last?.type === "assistant" && last.toolCalls) {
      const toolId = p.toolName;
      const newCalls = last.toolCalls.map((t) =>
        t.id === toolId ? { ...t, output: p.toolOutput } : t,
      );
      const newBlocks = last.blocks?.map((b) =>
        b.type === "tool" && b.toolCall?.id === toolId
          ? { ...b, toolCall: { ...b.toolCall!, output: p.toolOutput } }
          : b,
      );
      messages[messages.length - 1] = { ...last, toolCalls: newCalls, blocks: newBlocks };
    } else {
      messages.push(p);
    }
  }
}

interface TrackedSession {
  messages: AgentMessage[];
  slug: string;
  claudeSessionId: string | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  repoPath?: string;
  worktreeBranch?: string;
  /** Canonical `agent_sessions` row id used for the incremental remote PATCH.
   *  Equals sessionId for desktop-originated sessions; for job-originated
   *  sessions it is `data.agentSessionId` from `job.assigned`. When absent,
   *  `flushRemote` is a no-op and behavior matches pre-ISS-84. */
  agentSessionId?: string;
  messagesSinceRemoteFlush: number;
  incrementalTimer: ReturnType<typeof setTimeout> | null;
  remoteFlushInFlight: Promise<void> | null;
}

/**
 * Tracks active sessions and persists them locally via save_session_cmd.
 * Same save logic as useAgentChat's auto-save effect.
 */
export class SessionTracker {
  private sessions = new Map<string, TrackedSession>();
  private remotePersist?: SessionTrackerOptions["remotePersist"];

  constructor(opts?: SessionTrackerOptions) {
    this.remotePersist = opts?.remotePersist;
  }

  /** Start tracking a new session with the initial user message. */
  start(
    sessionId: string,
    slug: string,
    prompt: string,
    opts?: { repoPath?: string; worktreeBranch?: string; agentSessionId?: string },
  ): void {
    this.sessions.set(sessionId, {
      messages: [{ id: `user-1`, type: "user", timestamp: Date.now(), content: prompt }],
      slug,
      claudeSessionId: null,
      saveTimer: null,
      repoPath: opts?.repoPath,
      worktreeBranch: opts?.worktreeBranch,
      agentSessionId: opts?.agentSessionId,
      messagesSinceRemoteFlush: 0,
      incrementalTimer: null,
      remoteFlushInFlight: null,
    });
    this.scheduleSave(sessionId);
  }

  /** Get a tracked session's metadata. */
  getSession(sessionId: string): { worktreeBranch?: string; repoPath?: string; slug?: string; isReindex?: boolean } | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const firstMsg = s.messages[0]?.content ?? "";
    return { worktreeBranch: s.worktreeBranch, repoPath: s.repoPath, slug: s.slug, isReindex: typeof firstMsg === "string" && firstMsg.includes("Reindex") };
  }

  /** Get the full tracked-session state — messages + claudeSessionId — for
   *  the agent:complete PATCH that persists the run on the server (ISS-307).
   *  Returns undefined only if the session was never started or has been
   *  disposed; `complete()` keeps the accumulator alive across turns. */
  getSnapshot(sessionId: string): { messages: AgentMessage[]; claudeSessionId: string | null } | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return { messages: s.messages, claudeSessionId: s.claudeSessionId ?? null };
  }

  /** Add a follow-up user message. */
  addUserMessage(sessionId: string, content: string, claudeSessionId?: string | null): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.messages.push({ id: `user-${Date.now()}`, type: "user", timestamp: Date.now(), content });
    if (claudeSessionId) s.claudeSessionId = claudeSessionId;
    this.scheduleSave(sessionId);
    this.noteRemoteActivity(sessionId, 1);
  }

  /** Process a raw agent:message event — parse, merge, and schedule save. */
  handleStreamData(sessionId: string, data: unknown): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const { messages: parsed, sessionId: claudeSid } = parseStreamMessages(data);
    if (claudeSid) s.claudeSessionId = claudeSid;
    if (parsed.length > 0) {
      mergeMessages(s.messages, parsed);
      this.scheduleSave(sessionId);
      this.noteRemoteActivity(sessionId, parsed.length);
    }
  }

  /** Flush the pending save and clear the debounce timer, but keep the
   *  accumulator alive so follow-up turns append to the same history.
   *  The entry is only removed on `dispose()` (ISS-83). */
  complete(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.saveTimer) {
      clearTimeout(s.saveTimer);
      s.saveTimer = null;
    }
    if (s.incrementalTimer) {
      clearTimeout(s.incrementalTimer);
      s.incrementalTimer = null;
    }
    s.messagesSinceRemoteFlush = 0;
    this.saveNow(sessionId, s);
  }

  /** Drain pending incremental remote PATCHes for every session. Used on
   *  window unload (ISS-84) so a cooperative close still snapshots the
   *  in-flight turn before the renderer dies. */
  async flushAll(): Promise<void> {
    const inFlight: Promise<void>[] = [];
    for (const [sessionId, s] of this.sessions.entries()) {
      if (s.incrementalTimer) {
        clearTimeout(s.incrementalTimer);
        s.incrementalTimer = null;
      }
      if (s.messagesSinceRemoteFlush > 0) {
        this.flushRemote(sessionId, s);
      }
      if (s.remoteFlushInFlight) inFlight.push(s.remoteFlushInFlight);
    }
    await Promise.allSettled(inFlight);
  }

  /** Clean up all tracked sessions and timers. */
  dispose(): void {
    for (const s of this.sessions.values()) {
      if (s.saveTimer) clearTimeout(s.saveTimer);
      if (s.incrementalTimer) clearTimeout(s.incrementalTimer);
    }
    this.sessions.clear();
  }

  private scheduleSave(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.saveTimer) clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(() => {
      s.saveTimer = null;
      this.saveNow(sessionId, s);
    }, 1000);
  }

  private noteRemoteActivity(sessionId: string, count: number): void {
    if (!this.remotePersist) return;
    const s = this.sessions.get(sessionId);
    if (!s || !s.agentSessionId) return;
    s.messagesSinceRemoteFlush += count;
    if (s.messagesSinceRemoteFlush >= INCREMENTAL_FLUSH_MESSAGE_THRESHOLD) {
      if (s.incrementalTimer) {
        clearTimeout(s.incrementalTimer);
        s.incrementalTimer = null;
      }
      this.flushRemote(sessionId, s);
      return;
    }
    if (s.incrementalTimer == null) {
      s.incrementalTimer = setTimeout(() => {
        const cur = this.sessions.get(sessionId);
        if (!cur) return;
        cur.incrementalTimer = null;
        this.flushRemote(sessionId, cur);
      }, INCREMENTAL_FLUSH_INTERVAL_MS);
    }
  }

  private flushRemote(sessionId: string, s: TrackedSession): void {
    if (!this.remotePersist || !s.agentSessionId) return;
    const snapshot: SessionSnapshot = {
      messages: [...s.messages],
      claudeSessionId: s.claudeSessionId ?? null,
    };
    s.messagesSinceRemoteFlush = 0;
    s.remoteFlushInFlight = this.remotePersist(s.agentSessionId, snapshot).catch((err) => {
      console.warn("[session-tracker] incremental PATCH failed:", err);
    });
  }

  private saveNow(sessionId: string, s: TrackedSession): void {
    const title = (s.messages.find((m) => m.type === "user")?.content ?? "Untitled").slice(0, 80);
    invoke("save_session_cmd", {
      data: {
        id: sessionId,
        title,
        slug: s.slug,
        claude_session_id: s.claudeSessionId,
        strapi_session_id: sessionId,
        updated_at: new Date().toISOString(),
        messages: s.messages,
      },
    }).catch(() => {});
  }
}
