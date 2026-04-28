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

/**
 * Lightweight hook to stream agent run logs inline (no chat UI).
 * Subscribes to a session via WebSocket and extracts tool/text log lines.
 */
export function useAgentRunLog(): AgentRunLog {
  const [status, setStatus] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const startRun = useCallback((sessionId: string, label: string, agentDocumentId: string) => {
    sessionIdRef.current = sessionId || null;
    setActiveAgentId(agentDocumentId);
    setStatus(label);
    setLog([]);
    setIsRunning(true);

    if (sessionId) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
      }
    }
  }, []);

  const clear = useCallback(() => {
    sessionIdRef.current = null;
    setActiveAgentId(null);
    setStatus(null);
    setLog([]);
    setIsRunning(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        const sid = sessionIdRef.current;
        if (sid) ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (!sessionIdRef.current) return;
          if (msg.data?.sessionId && msg.data.sessionId !== sessionIdRef.current) return;

          if (msg.event === 'agent:message') {
            const d = msg.data;
            const content = d.message?.content;

            if (d.type === 'assistant' && Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  setLog((prev) => [...prev, block.text]);
                } else if (block.type === 'tool_use') {
                  let detail = '';
                  const input = block.input;
                  if (block.name === 'TodoWrite' || block.name === 'ToolSearch') {
                    // Skip — noise in the compact run log
                  } else if (block.name === 'AskUserQuestion') {
                    setLog((prev) => [...prev, '⏳ Waiting for user input…']);
                  } else if (block.name === 'Task') {
                    const desc = input?.description || input?.subagent_type || 'subtask';
                    setLog((prev) => [...prev, `🔀 Agent: ${desc}`]);
                  } else {
                    if (block.name === 'Bash' && input?.command) detail = ` $ ${String(input.command).slice(0, 120)}`;
                    else if (['Read', 'Write', 'Edit'].includes(block.name) && input?.file_path) detail = ` ${input.file_path}`;
                    else if (['Glob', 'Grep'].includes(block.name) && input?.pattern) detail = ` ${input.pattern}`;
                    else if (block.name?.startsWith('mcp__')) {
                      const tool = block.name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ');
                      detail = ` ${tool}`;
                    }
                    setLog((prev) => [...prev, `⚡ ${block.name ?? 'tool'}${detail}`]);
                  }
                }
              }
            }

            if (d.type === 'result') {
              const failed = d.is_error ?? false;
              setStatus(failed ? 'Run failed' : 'Run complete!');
              setIsRunning(false);
              sessionIdRef.current = null;
              setTimeout(() => { setStatus(null); setActiveAgentId(null); }, 5000);
            }
          } else if (msg.event === 'agent:complete') {
            setStatus('Run complete!');
            setIsRunning(false);
            sessionIdRef.current = null;
            setTimeout(() => { setStatus(null); setActiveAgentId(null); }, 5000);
          }
        } catch { /* ignore */ }
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
  }, []);

  return { status, log, isRunning, activeAgentId, startRun, clear };
}
