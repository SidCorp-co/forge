import { useEffect } from "react";
import { invoke } from "@/hooks/use-tauri-ipc";
import { parseStreamMessages } from "@/lib/stream-parser";
import { mergeMessages } from "@/lib/session-tracker";
import type { AgentMessage } from "@/lib/types";
import type { AgentUsage } from "@/stores/app-store";
import type { ProjectConfig } from "@/lib/types";

interface StoredSession {
  id: string;
  title: string;
  claude_session_id: string | null;
  strapi_session_id: string | null;
  messages: AgentMessage[];
  usage?: AgentUsage;
  worktree_path?: string;
  worktree_branch?: string;
}

export type { StoredSession };

interface MakeMessageFn {
  (type: AgentMessage["type"], content: string): AgentMessage;
}

export function useKnowledgeCheck(
  projectConfig: ProjectConfig | undefined,
  setHasKnowledge: (v: boolean) => void,
) {
  useEffect(() => {
    if (!projectConfig?.repoPath) return;
    invoke<unknown>("read_knowledge_index", { repoPath: projectConfig.repoPath })
      .then((data) => setHasKnowledge(!!data))
      .catch(() => {});
  }, [projectConfig?.repoPath]);
}

export function useAutoPopulatePrompt(
  confirmed: boolean,
  messagesLength: number,
  getActivePrompt: () => string | null,
  setPromptDraft: (v: string | null) => void,
  deps: unknown[],
) {
  useEffect(() => {
    if (confirmed || messagesLength > 0) return;
    const prompt = getActivePrompt();
    if (prompt) setPromptDraft(prompt);
  }, deps);
}

export function useStreamListener(
  slug: string | undefined,
  sessionIdRef: React.MutableRefObject<string>,
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>,
  setIsRunning: (v: boolean) => void,
  setClaudeSessionId: (v: string | null) => void,
  makeMessage: MakeMessageFn,
) {
  useEffect(() => {
    let unlisten1: (() => void) | undefined;
    let unlisten2: (() => void) | undefined;
    let unlisten3: (() => void) | undefined;
    let unlisten4: (() => void) | undefined;
    let cancelled = false;

    async function setup() {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;

        unlisten4 = await listen<{ sessionId: string; prompt: string; projectSlug: string }>("agent:session-adopted", (event) => {
          const { sessionId, prompt, projectSlug } = event.payload;
          if (projectSlug !== slug) return;
          sessionIdRef.current = sessionId;
          setMessages([makeMessage("user", prompt)]);
          setIsRunning(true);
        });

        unlisten3 = await listen<{ sessionId: string; content: string }>("agent:user-message", (event) => {
          if (event.payload.sessionId !== sessionIdRef.current) return;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.type === "user" && last.content === event.payload.content) return prev;
            return [...prev, makeMessage("user", event.payload.content)];
          });
          setIsRunning(true);
        });

        unlisten1 = await listen<{ sessionId: string; data: Record<string, unknown> }>("agent:message", (event) => {
          if (event.payload.sessionId !== sessionIdRef.current) return;
          const { messages: parsed, sessionId } = parseStreamMessages(event.payload.data);
          if (sessionId) setClaudeSessionId(sessionId);
          if (parsed.length > 0) {
            setMessages((prev) => {
              const updated = [...prev];
              mergeMessages(updated, parsed);
              return updated;
            });
          }
          if (event.payload.data.type === "result") setIsRunning(false);
        });

        unlisten2 = await listen<{ sessionId: string; error?: string }>("agent:complete", (event) => {
          if (event.payload.sessionId !== sessionIdRef.current) return;
          setIsRunning(false);
          if (event.payload.error) {
            setMessages((prev) => [...prev, makeMessage("system", `Error: ${event.payload.error}`)]);
          }
        });
      } catch {
        // Not in Tauri environment
      }
    }

    setup();
    return () => { cancelled = true; unlisten1?.(); unlisten2?.(); unlisten3?.(); unlisten4?.(); };
  }, []);
}

export function useAutoSave(
  messages: AgentMessage[],
  claudeSessionId: string | null,
  slug: string | undefined,
  agentUsage: AgentUsage,
  sessionIdRef: React.MutableRefObject<string>,
  strapiSessionIdRef: React.MutableRefObject<string | null>,
) {
  useEffect(() => {
    const userMsgs = messages.filter((m) => m.type === "user" || m.type === "assistant");
    if (userMsgs.length === 0) return;
    const timer = setTimeout(() => {
      const title = (messages.find((m) => m.type === "user")?.content ?? "Untitled").slice(0, 80);
      invoke("save_session_cmd", {
        data: {
          id: sessionIdRef.current,
          title,
          slug: slug ?? "",
          claude_session_id: claudeSessionId,
          strapi_session_id: strapiSessionIdRef.current,
          updated_at: new Date().toISOString(),
          messages,
          usage: agentUsage.turns > 0 ? agentUsage : undefined,
        },
      }).catch(() => {});
    }, 1000);
    return () => clearTimeout(timer);
  }, [messages, claudeSessionId, slug, agentUsage]);
}

export function useLoadSessions(
  activeItem: unknown,
  slug: string | undefined,
  setLoadingSessions: (v: boolean) => void,
  setSavedSessions: (v: SessionMeta[]) => void,
) {
  useEffect(() => {
    if (activeItem || !slug) return;
    setLoadingSessions(true);
    invoke("list_sessions", { slug })
      .then((s) => setSavedSessions(s as SessionMeta[]))
      .catch(() => {})
      .finally(() => setLoadingSessions(false));
  }, [activeItem, slug]);
}

export interface SessionMeta {
  id: string;
  title: string;
  slug: string;
  updated_at: string;
}
