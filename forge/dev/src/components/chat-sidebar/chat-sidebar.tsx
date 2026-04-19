'use client';

import { useState, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getChatSessions, getChatSession, sendChatMessage, uploadFile, createIssue } from "@/lib/api";
import { useChatStream } from "@/hooks/use-chat-stream";
import { useMountedRef } from "@/hooks/use-mounted-ref";
import { SessionsList } from "./sessions-list";
import { ChatPanel } from "./chat-panel";
import { parseStoredMessages } from "./helpers";
import type { SessionSummary } from "./sessions-list";
import type { ChatMessageData } from "@/lib/types";

interface ChatSidebarProps {
  projectSlug: string;
  onClose: () => void;
}

export function ChatSidebar({ projectSlug, onClose }: ChatSidebarProps) {
  const [view, setView] = useState<"sessions" | "chat">("sessions");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState("New Chat");
  const queryClient = useQueryClient();
  const mountedRef = useMountedRef();

  const { streamingMsgId, subscribe } = useChatStream(sessionId, setMessages);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const data = await getChatSessions(projectSlug);
      if (mountedRef.current) setSessions(data || []);
    } catch {
      if (mountedRef.current) setSessions([]);
    } finally {
      if (mountedRef.current) setLoadingSessions(false);
    }
  }, [projectSlug]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const openSession = async (session: SessionSummary) => {
    try {
      const res = await getChatSession(session.documentId);
      if (!mountedRef.current) return;
      setMessages(parseStoredMessages(res.messages || []));
      setSessionTitle(res.title || "Chat");
    } catch {
      if (!mountedRef.current) return;
      setMessages([]);
      setSessionTitle(session.title || "Chat");
    } finally {
      if (mountedRef.current) { setSessionId(session.documentId); setView("chat"); }
    }
  };

  const startNewChat = () => { setMessages([]); setSessionId(null); setSessionTitle("New Chat"); setView("chat"); };
  const goBack = () => { loadSessions(); setView("sessions"); };

  const handleSend = async (text: string, files: File[]) => {
    if (!text && files.length === 0) return;

    const fileUrls: { url: string; name: string }[] = [];
    for (const file of files) {
      const result = await uploadFile(file);
      if (result) fileUrls.push(result);
    }

    const userMsg: ChatMessageData = {
      id: crypto.randomUUID(), role: "user", content: text, timestamp: Date.now(),
      attachments: fileUrls.length > 0 ? fileUrls : undefined,
    };

    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessageData = { id: assistantId, role: "assistant", content: "", timestamp: Date.now(), isStreaming: true };

    streamingMsgId.current = assistantId;
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setSending(true);

    const messageText = fileUrls.length > 0 ? `${text}\n\n[Attached images: ${fileUrls.map((f) => f.url).join(", ")}]` : text;

    try {
      const res = await sendChatMessage(projectSlug, messageText, sessionId);
      if (!mountedRef.current) return;

      if (res.sessionId) {
        setSessionId(res.sessionId);
        subscribe(res.sessionId);
        if (sessionTitle === "New Chat") setSessionTitle(text.slice(0, 60));
      }

      setMessages((prev) => prev.map((m) => {
        if (m.id !== assistantId) return m;
        const finalContent = m.content || res.reply || "(no response)";
        const finalTools = m.toolCalls?.length
          ? m.toolCalls.map((tc, i) => ({ ...tc, isStreaming: false, durationMs: res.toolCalls?.[i]?.durationMs ?? tc.durationMs, isError: res.toolCalls?.[i]?.isError ?? tc.isError }))
          : res.toolCalls?.map((tc) => ({ id: crypto.randomUUID(), name: tc.name, input: tc.input, durationMs: tc.durationMs, isError: tc.isError }));
        return { ...m, content: finalContent, isStreaming: false, toolCalls: finalTools };
      }));
    } catch (err) {
      if (!mountedRef.current) return;
      setMessages((prev) => prev.map((m) =>
        m.id === assistantId ? { ...m, content: `Error: ${err instanceof Error ? err.message : "Failed"}`, isStreaming: false } : m,
      ));
    } finally {
      if (mountedRef.current) setSending(false);
      streamingMsgId.current = null;
    }
  };

  const handleCreateIssue = async () => {
    const userMessages = messages.filter((m) => m.role === "user");
    if (userMessages.length === 0) return;
    const title = userMessages[0].content.split("\n")[0].slice(0, 120);
    const description = userMessages.map((m) => m.content).join("\n\n");

    setCreating(true);
    try {
      await createIssue({ title, description, priority: "medium", project: projectSlug });
      if (!mountedRef.current) return;
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "system" as const, content: `Issue created: "${title}"`, timestamp: Date.now() }]);
    } catch {} finally {
      if (mountedRef.current) setCreating(false);
    }
  };

  if (view === "sessions") {
    return (
      <SessionsList
        sessions={sessions}
        loading={loadingSessions}
        onSelectSession={openSession}
        onNewChat={startNewChat}
        onClose={onClose}
      />
    );
  }

  return (
    <ChatPanel
      sessionTitle={sessionTitle}
      messages={messages}
      sending={sending}
      creating={creating}
      onSend={handleSend}
      onBack={goBack}
      onClose={onClose}
      onCreateIssue={handleCreateIssue}
    />
  );
}
