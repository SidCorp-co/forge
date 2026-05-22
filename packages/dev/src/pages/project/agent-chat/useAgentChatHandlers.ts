import { invoke } from "@/hooks/use-tauri-ipc";
import { uploadFile, startAgentSession, sendAgentSession, coreMediaUrl } from "@/lib/api";
import type { AgentMessage } from "@/lib/types";
import type { AgentUsage } from "@/stores/app-store";
import type { ProjectConfig } from "@/lib/types";
import type { StoredSession } from "./useAgentChatEffects";

interface MakeMessageFn {
  (type: AgentMessage["type"], content: string): AgentMessage;
}

interface HandlerDeps {
  slug: string | undefined;
  projectConfig: ProjectConfig | undefined;
  hasRepoPath: boolean;
  isRunning: boolean;
  input: string;
  claudeSessionId: string | null;
  sessionIdRef: React.MutableRefObject<string>;
  strapiSessionIdRef: React.MutableRefObject<string | null>;
  issueDocIds: string[];
  setInput: (v: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>;
  setIsRunning: (v: boolean) => void;
  setClaudeSessionId: (v: string | null) => void;
  setRestoredSessionTitle: (v: string | null) => void;
  resetAgentUsage: () => void;
  updateAgentUsageFromStored: (u: AgentUsage) => void;
  setSavedSessions: React.Dispatch<React.SetStateAction<{ id: string; title: string; slug: string; updated_at: string }[]>>;
  makeMessage: MakeMessageFn;
  getActivePrompt: () => string | null;
  getMcpServersParam: () => Record<string, unknown> | undefined;
  activeItem: unknown;
}

export function createHandlers(deps: HandlerDeps) {
  const {
    slug, projectConfig, hasRepoPath, isRunning, input, claudeSessionId,
    sessionIdRef, strapiSessionIdRef, issueDocIds,
    setInput, setMessages, setIsRunning, setClaudeSessionId,
    setRestoredSessionTitle, resetAgentUsage, updateAgentUsageFromStored,
    setSavedSessions, makeMessage, getActivePrompt, getMcpServersParam, activeItem,
  } = deps;

  // TODO(tech-debt, follow-up): this hook double-dispatches — calls
  // `startAgentSession` (creates a cloud agent_sessions row) AND spawns the
  // Claude CLI locally via `invoke('send_chat', ...)`. After PR-3 moved the
  // chat preamble to the server (`prompt/system.ts:buildChatPreamble`), the
  // local spawn here no longer receives a system prompt and the orientation
  // nudge reaches the CLI only via the user-prompt prefix on the first turn.
  // Cleanup options for a follow-up PR:
  //   (a) drop the local invoke — rely entirely on the cloud→WS→runner path,
  //   (b) call `POST /api/prompts/preview { kind: 'chat' }` here and pass
  //       result as `systemPrompt` so the SSOT preamble reaches the CLI.
  // See docs/proposals/pipeline-prompt-ssot.md §"Out of scope (follow-up)".
  async function handleSend(filesOrText?: File[] | string) {
    const textOverride = typeof filesOrText === "string" ? filesOrText : undefined;
    const files = Array.isArray(filesOrText) ? filesOrText : undefined;
    const rawMsg = textOverride ?? input.trim();
    if (!rawMsg && (!files || files.length === 0)) return;
    if (!hasRepoPath || isRunning) return;
    const userMsg = rawMsg;
    if (!textOverride) setInput("");

    let fileInfo = "";
    if (files && files.length > 0) {
      const uploaded: { id: number; url: string; name: string }[] = [];
      for (const file of files) {
        const res = await uploadFile(file);
        if (res) uploaded.push(res);
      }
      if (uploaded.length > 0) {
        fileInfo = `\n\n[Attached files: ${uploaded.map((f) => `[${f.name}](${coreMediaUrl(f.url)}) (media ID: ${f.id})`).join(", ")}]`;
      }
    }

    const displayMsg = userMsg + (fileInfo ? `\n\n[${files!.length} file(s) attached]` : "");
    setMessages((prev) => [...prev, makeMessage("user", displayMsg)]);
    setIsRunning(true);

    const isFirst = !claudeSessionId;
    const activePrompt = getActivePrompt();
    const fullMsg = userMsg + fileInfo;
    const prompt = isFirst && activePrompt ? `${activePrompt}\n\n---\n\nUser message: ${fullMsg}` : fullMsg;

    try {
      if (!strapiSessionIdRef.current) {
        try {
          const result = await startAgentSession(slug!, prompt, projectConfig?.repoPath, issueDocIds.length > 0 ? issueDocIds : undefined);
          strapiSessionIdRef.current = result.documentId;
          sessionIdRef.current = result.documentId;
        } catch { /* ignore */ }
      } else {
        sendAgentSession(strapiSessionIdRef.current, fullMsg, claudeSessionId).catch(() => {});
      }

      await invoke("send_chat", {
        repoPath: projectConfig!.repoPath, message: prompt,
        sessionId: sessionIdRef.current, claudeSessionId,
        projectSlug: slug,
        mcpServers: getMcpServersParam(),
      });
    } catch (err) {
      setIsRunning(false);
      setMessages((prev) => [...prev, makeMessage("system", `Failed to send: ${err}`)]);
    }
  }

  async function handleRunAgent() {
    if (!activeItem || !hasRepoPath || isRunning) return;
    setIsRunning(true);
    const prompt = getActivePrompt()!;
    setMessages([makeMessage("user", prompt)]);
    try {
      try {
        const result = await startAgentSession(slug!, prompt, projectConfig?.repoPath, issueDocIds.length > 0 ? issueDocIds : undefined);
        strapiSessionIdRef.current = result.documentId;
        sessionIdRef.current = result.documentId;
      } catch { /* ignore */ }

      await invoke("send_chat", {
        repoPath: projectConfig!.repoPath, message: prompt,
        sessionId: sessionIdRef.current, claudeSessionId: null,
        projectSlug: slug,
        mcpServers: getMcpServersParam(),
      });
    } catch (err) {
      setIsRunning(false);
      setMessages((prev) => [...prev, makeMessage("system", `Failed to start agent: ${err}`)]);
    }
  }

  async function handleAbort() {
    try { await invoke("abort_agent", { sessionId: sessionIdRef.current }); } catch {}
    setIsRunning(false);
  }

  async function handleOpenTerminal() {
    if (!projectConfig?.repoPath) return;
    await invoke("open_terminal", {
      repoPath: projectConfig.repoPath,
      systemPrompt: getActivePrompt() ?? undefined,
      claudeSessionId: claudeSessionId ?? undefined,
    });
  }

  function handleNewChat() {
    setMessages([]);
    setClaudeSessionId(null);
    setIsRunning(false);
    setRestoredSessionTitle(null);
    resetAgentUsage();
    sessionIdRef.current = `agent-${Date.now()}`;
    strapiSessionIdRef.current = null;
  }

  async function handleRestoreSession(id: string) {
    try {
      const session = await invoke("load_session", { id }) as StoredSession;
      sessionIdRef.current = session.id;
      strapiSessionIdRef.current = session.strapi_session_id || session.id;
      setClaudeSessionId(session.claude_session_id);
      setMessages(session.messages);
      setRestoredSessionTitle(session.title);
      if (session.usage && session.usage.turns > 0) {
        updateAgentUsageFromStored(session.usage);
      } else {
        resetAgentUsage();
      }
    } catch {}
  }

  async function handleDeleteSession(id: string) {
    await invoke("delete_session", { id }).catch(() => {});
    setSavedSessions((prev) => prev.filter((s) => s.id !== id));
  }

  return { handleSend, handleRunAgent, handleAbort, handleOpenTerminal, handleNewChat, handleRestoreSession, handleDeleteSession };
}
