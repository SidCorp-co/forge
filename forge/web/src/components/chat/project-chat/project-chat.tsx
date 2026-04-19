'use client';

import { useState, useRef, useCallback } from 'react';
import { apiClient, apiUpload, strapiMediaUrl } from '@/lib/api/client';
import { useIssue } from '@/features/issue/hooks/use-issues';
import type { ChatMessageData } from '../chat-message';
import { useChatSessions } from './use-chat-sessions';
import { useChatWebSocket } from './use-chat-websocket';
import { SessionsView } from './sessions-view';
import { ChatView } from './chat-view';

interface ProjectChatProps {
  projectSlug: string;
  activeIssueId?: string;
  onClose: () => void;
}

type View = 'sessions' | 'chat';

export function ProjectChat({ projectSlug, activeIssueId, onClose }: ProjectChatProps) {
  const [view, setView] = useState<View>('sessions');
  const [sending, setSending] = useState(false);
  const { data: issueData } = useIssue(activeIssueId ?? '');
  const activeIssue = activeIssueId ? issueData?.data : undefined;
  const {
    sessions,
    loadingSessions,
    messages,
    setMessages,
    sessionId,
    setSessionId,
    sessionTitle,
    setSessionTitle,
    loadSessions,
    openSession: openSessionBase,
    startNewChat: startNewChatBase,
    mountedRef,
  } = useChatSessions(projectSlug);

  const { streamingMsgId, pendingRequestId, subscribeToSession } = useChatWebSocket({
    sessionId,
    setSessionId,
    setMessages,
  });

  const openSession = async (session: { documentId: string; title: string; createdAt: string; updatedAt: string }) => {
    await openSessionBase(session);
    setView('chat');
  };

  const startNewChat = () => {
    startNewChatBase();
    setView('chat');
  };

  const goBack = () => {
    loadSessions();
    setView('sessions');
  };

  // --- Send ---
  const handleSend = async (text: string, files: File[]) => {
    if (!text && files.length === 0) return;

    // Upload files if any
    const uploaded: { id: number; url: string; name: string }[] = [];
    if (files.length > 0) {
      for (const file of files) {
        try {
          const formData = new FormData();
          formData.append('files', file);
          const data = await apiUpload(formData);
          if (data[0]?.id) uploaded.push({ id: data[0].id, url: data[0].url, name: file.name });
        } catch { /* continue without this file */ }
      }
    }

    const userMsg: ChatMessageData = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      attachments: uploaded.length > 0 ? uploaded : undefined,
    };

    // Create streaming placeholder for assistant
    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessageData = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    streamingMsgId.current = assistantId;
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setSending(true);

    // Generate requestId for WS session matching (enables streaming for new sessions)
    const requestId = crypto.randomUUID();
    pendingRequestId.current = requestId;

    // Append file info to message for the agent
    const messageText = uploaded.length > 0
      ? `${text}\n\n[Attached files (uploaded to Strapi media): ${uploaded.map((f) => `[${f.name}](${strapiMediaUrl(f.url)}) (media ID: ${f.id})`).join(', ')}]`
      : text;

    try {
      // Build page context for system prompt when viewing an issue
      const pageContext = activeIssue ? {
        page: 'issue_detail',
        issueId: activeIssue.id,
        issueDocumentId: activeIssue.documentId,
        issueTitle: activeIssue.title,
        issueStatus: activeIssue.status,
        issuePriority: activeIssue.priority,
        ...(activeIssue.category ? { issueCategory: activeIssue.category } : {}),
      } : undefined;

      const res = await apiClient<{
        data: { sessionId: string; streaming?: boolean; reply?: string; toolCalls?: { name: string; input: any; durationMs?: number; isError?: boolean }[] };
      }>('/chat', {
        method: 'POST',
        body: JSON.stringify({ projectSlug, message: messageText, sessionId, requestId, pageContext }),
      });

      if (!mountedRef.current) return;

      if (res.data.sessionId) {
        setSessionId(res.data.sessionId);
        subscribeToSession(res.data.sessionId);
        if (sessionTitle === 'New Chat') {
          setSessionTitle(text.slice(0, 60));
        }
      }

      // When streaming, WS events handle message updates (chat:done / chat:complete)
      // Only finalize from HTTP if the response contains the full reply (non-streaming fallback)
      if (!res.data.streaming) {
        streamingMsgId.current = null;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            const finalContent = m.content || res.data.reply || '(no response)';
            const finalTools = m.toolCalls?.length
              ? m.toolCalls.map((tc, i) => ({
                  ...tc,
                  isStreaming: false,
                  durationMs: res.data.toolCalls?.[i]?.durationMs ?? tc.durationMs,
                  isError: res.data.toolCalls?.[i]?.isError ?? tc.isError,
                }))
              : res.data.toolCalls?.map((tc) => ({
                  id: crypto.randomUUID(),
                  name: tc.name,
                  input: tc.input,
                  durationMs: tc.durationMs,
                  isError: tc.isError,
                }));
            return {
              ...m,
              content: finalContent,
              isStreaming: false,
              toolCalls: finalTools,
            };
          })
        );
      }
    } catch (err) {
      if (!mountedRef.current) return;
      streamingMsgId.current = null;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Error: ${err instanceof Error ? err.message : 'Failed to get response'}`, isStreaming: false }
            : m
        )
      );
    } finally {
      if (mountedRef.current) setSending(false);
      // Don't clear streamingMsgId here for streaming responses — WS events (chat:done/chat:complete) handle it
    }
  };

  // Toggle between sessions list and chat view (chat overlays sessions)
  return (
    <div className="flex h-full flex-col">
      {view === 'sessions' ? (
        <SessionsView
          sessions={sessions}
          loadingSessions={loadingSessions}
          onSelect={openSession}
          onNew={startNewChat}
          onClose={onClose}
          issueContext={activeIssue ? { id: activeIssue.id, title: activeIssue.title } : undefined}
        />
      ) : (
        <ChatView
          messages={messages}
          sessionTitle={sessionTitle}
          sending={sending}
          onSend={handleSend}
          onBack={goBack}
          onClose={onClose}
          issueContext={activeIssue ? { id: activeIssue.id, title: activeIssue.title } : undefined}
        />
      )}
    </div>
  );
}
