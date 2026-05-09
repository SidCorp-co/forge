import { useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useQueryClient } from "@tanstack/react-query";

export function useChatStream(sessionId: string | null) {
  const auth = useAuth();
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
    if (!auth.coreUrl) return;
    const wsUrl = auth.coreUrl.replace(/^http/, "ws") + "/ws";
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
