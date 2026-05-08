'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { WS_URL } from '@/lib/api/client';

export interface AgentRunLog {
  status: string | null;
  log: string[];
  isRunning: boolean;
  /** documentId of the agent currently running */
  activeAgentId: string | null;
  startRun: (sessionId: string, label: string, agentDocumentId: string) => void;
  clear: () => void;
}

const MAX_LOG_LINES = 200;

/**
 * Stream agent run logs inline. Subscribes to the project room (modern WS
 * protocol: `{type:'subscribe', room:'project:<uuid>'}`) and filters events
 * by the active session id. Unwraps `agent-session.relay.<event>` so payloads
 * pushed by desktop runners hit the same handler as direct events.
 */
export function useAgentRunLog(projectId: string | undefined): AgentRunLog {
  const [status, setStatus] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const projectIdRef = useRef<string | null>(projectId ?? null);
  projectIdRef.current = projectId ?? null;

  const startRun = useCallback((sessionId: string, label: string, agentDocumentId: string) => {
    sessionIdRef.current = sessionId || null;
    setActiveAgentId(agentDocumentId);
    setStatus(label);
    setLog([]);
    setIsRunning(true);
  }, []);

  const clear = useCallback(() => {
    sessionIdRef.current = null;
    setActiveAgentId(null);
    setStatus(null);
    setLog([]);
    setIsRunning(false);
  }, []);

  const appendLine = useCallback((line: string) => {
    setLog((prev) => {
      const next = [...prev, line];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function dispatch(event: string, data: any) {
      if (!sessionIdRef.current) return;
      if (data?.sessionId && data.sessionId !== sessionIdRef.current) return;

      if (event === 'agent:message') {
        const content = data?.message?.content;
        if (data?.type === 'assistant' && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              appendLine(block.text);
            } else if (block.type === 'tool_use') {
              const input = block.input;
              if (block.name === 'TodoWrite' || block.name === 'ToolSearch') {
                continue;
              } else if (block.name === 'AskUserQuestion') {
                appendLine('⏳ Waiting for user input…');
              } else if (block.name === 'Task') {
                const desc = input?.description || input?.subagent_type || 'subtask';
                appendLine(`🔀 Agent: ${desc}`);
              } else {
                let detail = '';
                if (block.name === 'Bash' && input?.command) {
                  detail = ` $ ${String(input.command).slice(0, 120)}`;
                } else if (['Read', 'Write', 'Edit'].includes(block.name) && input?.file_path) {
                  detail = ` ${input.file_path}`;
                } else if (['Glob', 'Grep'].includes(block.name) && input?.pattern) {
                  detail = ` ${input.pattern}`;
                } else if (block.name?.startsWith('mcp__')) {
                  const tool = block.name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ');
                  detail = ` ${tool}`;
                }
                appendLine(`⚡ ${block.name ?? 'tool'}${detail}`);
              }
            }
          }
        }

        if (data?.type === 'result') {
          const failed = data.is_error ?? false;
          setStatus(failed ? 'Run failed' : 'Run complete!');
          setIsRunning(false);
          sessionIdRef.current = null;
          setTimeout(() => {
            setStatus(null);
            setActiveAgentId(null);
          }, 5000);
        }
      } else if (event === 'agent:complete') {
        setStatus('Run complete!');
        setIsRunning(false);
        sessionIdRef.current = null;
        setTimeout(() => {
          setStatus(null);
          setActiveAgentId(null);
        }, 5000);
      }
    }

    function handleMessage(msg: any) {
      // Unwrap relay envelope: `agent-session.relay.<event>` carries the
      // original payload on `data.payload` and the session id on `data.sessionId`.
      if (typeof msg.event === 'string' && msg.event.startsWith('agent-session.relay.')) {
        const innerEvent = msg.event.slice('agent-session.relay.'.length);
        const wrap = msg.data ?? {};
        const inner = { sessionId: wrap.sessionId, ...(wrap.payload ?? {}) };
        if (innerEvent === 'agent:batch' && Array.isArray(inner.items)) {
          for (const item of inner.items) {
            dispatch(item.event, { sessionId: inner.sessionId, ...(item.data ?? {}) });
          }
          return;
        }
        dispatch(innerEvent, inner);
        return;
      }

      if (msg.event === 'agent:batch' && Array.isArray(msg.data?.items)) {
        const sessionId = msg.data.sessionId;
        for (const item of msg.data.items) {
          dispatch(item.event, { sessionId, ...(item.data ?? {}) });
        }
        return;
      }

      dispatch(msg.event, msg.data ?? {});
    }

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        const pid = projectIdRef.current;
        if (pid) ws.send(JSON.stringify({ type: 'subscribe', room: `project:${pid}` }));
      };

      ws.onmessage = (event) => {
        try {
          handleMessage(JSON.parse(event.data));
        } catch {
          /* ignore */
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!disposed) reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [appendLine]);

  // Re-subscribe when project id resolves after the socket already opened.
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && projectId) {
      ws.send(JSON.stringify({ type: 'subscribe', room: `project:${projectId}` }));
    }
  }, [projectId]);

  return { status, log, isRunning, activeAgentId, startRun, clear };
}
