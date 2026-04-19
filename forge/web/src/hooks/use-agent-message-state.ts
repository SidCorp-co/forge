'use client';

import { useState, useRef, useEffect } from 'react';
import type { ChatMessageData } from '@/components/chat/chat-message';
import type { AgentUsage } from '@/features/agent/api';

const EMPTY_USAGE: AgentUsage = { contextUsed: 0, inputTotal: 0, outputTotal: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

export function useAgentMessageState() {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [desktopConnected, setDesktopConnected] = useState(false);
  const [usage, setUsage] = useState(EMPTY_USAGE);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  const streamingMsgId = useRef<string | null>(null);
  const streamingTextRef = useRef('');

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  function clearStreamState() {
    setMessages([]);
    setSessionId(null);
    setClaudeSessionId(null);
    setIsRunning(false);
    setUsage(EMPTY_USAGE);
    streamingMsgId.current = null;
    streamingTextRef.current = '';
  }

  return {
    messages, setMessages,
    isRunning, setIsRunning,
    sessionId, setSessionId,
    claudeSessionId, setClaudeSessionId,
    desktopConnected, setDesktopConnected,
    usage, setUsage,
    mountedRef, sessionIdRef,
    streamingMsgId, streamingTextRef,
    clearStreamState,
    EMPTY_USAGE,
  };
}
