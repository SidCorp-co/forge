'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { apiClient } from '@/lib/api/client';
import type { ChatMessageData } from '../chat-message';
import { deserializeMessages } from './chat-message-deserializer';

export interface SessionSummary {
  documentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export function useChatSessions(projectSlug: string) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('New Chat');
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const res = await apiClient<{ data: SessionSummary[] }>(
        `/chat-sessions?filters[project][slug][$eq]=${projectSlug}&sort=updatedAt:desc&pagination[pageSize]=50`
      );
      if (mountedRef.current) setSessions(res.data || []);
    } catch {
      if (mountedRef.current) setSessions([]);
    } finally {
      if (mountedRef.current) setLoadingSessions(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const openSession = async (session: SessionSummary) => {
    try {
      const res = await apiClient<{ data: { documentId: string; title: string; messages: any[] } }>(
        `/chat-sessions/${session.documentId}`
      );
      if (!mountedRef.current) return;
      const stored = res.data.messages || [];
      const loaded = deserializeMessages(stored);
      setMessages(loaded);
      setSessionTitle(res.data.title || 'Chat');
    } catch {
      if (!mountedRef.current) return;
      setMessages([]);
      setSessionTitle(session.title || 'Chat');
    } finally {
      if (mountedRef.current) {
        setSessionId(session.documentId);
      }
    }
  };

  const startNewChat = () => {
    setMessages([]);
    setSessionId(null);
    setSessionTitle('New Chat');
  };

  return {
    sessions,
    loadingSessions,
    messages,
    setMessages,
    sessionId,
    setSessionId,
    sessionTitle,
    setSessionTitle,
    loadSessions,
    openSession,
    startNewChat,
    mountedRef,
  };
}
