'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Send, Trash2 } from 'lucide-react';
import { Shell } from '@/components/layout/shell';
import { useProjects } from '@/features/project/hooks/use-projects';
import {
  useChatSessions,
  useChatSession,
  useCreateChatSession,
  useDeleteChatSession,
} from '@/features/chat-session/hooks/use-chat-sessions';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { formatApiError } from '@/lib/api/error';
import { cn } from '@/lib/utils/cn';
import { chatSessionApi } from '@/features/chat-session/api';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatMessage } from '@/features/chat-session/types';

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  const text =
    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
  return (
    <div className={cn('flex gap-2', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
          isUser
            ? 'bg-primary text-on-primary'
            : 'bg-surface-container-high text-on-surface',
        )}
      >
        {text}
      </div>
    </div>
  );
}

export default function ChatPage() {
  useSetPageTitle('Chat');
  const { data: projects } = useProjects();
  const [projectId, setProjectId] = useState<string | undefined>();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');

  useEffect(() => {
    if (!projectId && projects && projects.length > 0) {
      setProjectId(projects[0]?.id);
    }
  }, [projects, projectId]);

  const qc = useQueryClient();
  const sessionsQuery = useChatSessions(projectId);
  const sessions = sessionsQuery.data ?? [];
  const sessionDetail = useChatSession(activeSessionId);
  const createSession = useCreateChatSession(projectId);
  const deleteSession = useDeleteChatSession(projectId);
  const [sendError, setSendError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);

  const activeSession = useMemo(
    () => sessionDetail.data ?? sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessionDetail.data, sessions, activeSessionId],
  );

  function handleNew() {
    if (!projectId) return;
    createSession.mutate(
      { title: null },
      {
        onSuccess: (created) => setActiveSessionId(created.id),
      },
    );
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !projectId || sending) return;
    setSendError(null);
    setSending(true);
    try {
      let sessionId = activeSessionId;
      if (!sessionId) {
        const created = await createSession.mutateAsync({ title: text.slice(0, 80) });
        sessionId = created.id;
        setActiveSessionId(sessionId);
      }
      await chatSessionApi.sendMessage(sessionId, { content: text });
      setInput('');
      qc.invalidateQueries({ queryKey: ['chat-session', sessionId] });
      qc.invalidateQueries({ queryKey: ['chat-sessions', projectId] });
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
    }
  }

  function handleDelete(id: string) {
    if (!confirm('Delete this chat session?')) return;
    deleteSession.mutate(id, {
      onSuccess: () => {
        if (activeSessionId === id) setActiveSessionId(null);
      },
    });
  }

  return (
    <Shell>
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-outline-variant/30 bg-surface-container-low px-6 py-3">
          <div>
            <h1 className="text-lg font-semibold text-on-surface">Chat</h1>
            <p className="text-xs text-primary-fixed">
              Project chat sessions backed by core /api/chat-sessions.
            </p>
          </div>
          <select
            value={projectId ?? ''}
            onChange={(e) => {
              setProjectId(e.target.value || undefined);
              setActiveSessionId(null);
            }}
            className="rounded border border-outline-variant/30 bg-surface px-3 py-1.5 text-xs"
          >
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          <aside className="hidden w-72 shrink-0 flex-col overflow-hidden border-r border-outline-variant/30 bg-surface-container-low md:flex">
            <div className="flex items-center justify-between border-b border-outline-variant/30 px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wider text-primary-fixed">
                Sessions
              </span>
              <button
                type="button"
                onClick={handleNew}
                disabled={!projectId || createSession.isPending}
                className="inline-flex items-center gap-1 rounded border border-outline-variant/30 bg-surface px-2 py-1 text-[11px] text-on-surface hover:bg-surface-container disabled:opacity-50"
              >
                <Plus className="h-3 w-3" />
                New
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sessionsQuery.isLoading ? (
                <div className="space-y-2 p-3">
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </div>
              ) : sessions.length === 0 ? (
                <p className="p-4 text-xs text-outline">No sessions yet.</p>
              ) : (
                <ul className="divide-y divide-outline-variant/20">
                  {sessions.map((s) => (
                    <li
                      key={s.id}
                      className={cn(
                        'group flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-surface-container',
                        activeSessionId === s.id && 'bg-info-surface/20',
                      )}
                      onClick={() => setActiveSessionId(s.id)}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-on-surface">
                          {s.title || 'Untitled chat'}
                        </p>
                        <p className="truncate text-[10px] text-outline">
                          {new Date(s.updatedAt).toLocaleString()}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(s.id);
                        }}
                        className="rounded p-1 text-outline opacity-0 hover:bg-danger-surface hover:text-danger group-hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          <main className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {!activeSession ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-outline">
                    {sessions.length === 0
                      ? 'Type a message below to start a new chat.'
                      : 'Select a session or start a new one.'}
                  </p>
                </div>
              ) : (activeSession.messages ?? []).length === 0 ? (
                <p className="text-center text-xs text-outline">No messages yet.</p>
              ) : (
                (activeSession.messages ?? []).map((m, i) => (
                  <MessageBubble key={i} msg={m} />
                ))
              )}
            </div>

            <form
              onSubmit={handleSend}
              className="flex items-end gap-2 border-t border-outline-variant/30 bg-surface-container-low p-3"
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message…"
                rows={2}
                disabled={!projectId || sending}
                className="flex-1 resize-none rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend(e as unknown as React.FormEvent);
                  }
                }}
              />
              <button
                type="submit"
                disabled={!input.trim() || !projectId || sending}
                className="inline-flex items-center gap-1 rounded bg-primary px-3 py-2 text-xs text-on-primary hover:bg-primary/90 disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                {sending ? 'Sending…' : 'Send'}
              </button>
            </form>
            {sendError != null && (
              <p className="px-3 pb-2 text-[10px] uppercase tracking-widest text-error">
                {formatApiError(sendError)}
              </p>
            )}
          </main>
        </div>
      </div>
    </Shell>
  );
}
