import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatMessageData, ToolCallData } from "@/lib/types";

export function useChatStream(
  sessionId: string | null,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageData[]>>,
) {
  const config = useAppStore((s) => s.config);
  const queryClient = useQueryClient();
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const wsRef = useRef<WebSocket | null>(null);
  const streamingMsgId = useRef<string | null>(null);

  const subscribe = useCallback((sid: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
    }
  }, []);

  const unsubscribe = useCallback((sid: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "unsubscribe", sessionId: sid }));
    }
  }, []);

  useEffect(() => {
    const wsUrl = config.strapiUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => { if (sessionId) subscribe(sessionId); };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.event?.startsWith("issue:") || msg.event?.startsWith("task:") || msg.event?.startsWith("agent:")) {
          const qc = queryClientRef.current;
          const keys = msg.event.startsWith("task:") || msg.event.startsWith("agent:")
            ? ["tasks"] : ["issues", "issue", "comments"];
          keys.forEach((k) => qc.invalidateQueries({ queryKey: [k], refetchType: "all" }));
        }

        const mid = streamingMsgId.current;
        if (!mid) return;

        if (msg.event === "chat:text_delta") {
          setMessages((prev) => prev.map((m) =>
            m.id === mid ? { ...m, content: m.content + (msg.data?.text || "") } : m,
          ));
        } else if (msg.event === "chat:tool_use") {
          const toolCall: ToolCallData = {
            id: msg.data?.id || crypto.randomUUID(),
            name: msg.data?.name || "tool",
            isStreaming: true,
          };
          setMessages((prev) => prev.map((m) =>
            m.id === mid ? { ...m, toolCalls: [...(m.toolCalls || []), toolCall] } : m,
          ));
        } else if (msg.event === "chat:done") {
          setMessages((prev) => prev.map((m) => {
            if (m.id !== mid) return m;
            return { ...m, isStreaming: false, toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isStreaming: false })) };
          }));
          streamingMsgId.current = null;
        }
      } catch { /* ignore */ }
    };

    ws.onerror = () => ws.close();
    return () => { ws.close(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sessionId) subscribe(sessionId);
    return () => { if (sessionId) unsubscribe(sessionId); };
  }, [sessionId, subscribe, unsubscribe]);

  return { streamingMsgId, subscribe };
}
