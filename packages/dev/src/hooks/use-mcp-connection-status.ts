import { useCallback, useEffect, useRef, useState } from "react";
import type { McpServerConfig } from "@/lib/types";
import { isRemote } from "@/components/settings/mcp-server-list/helpers";
import { Sentry, isSentryEnabled } from "@/lib/sentry";

export type McpConnStatus = "idle" | "pinging" | "ok" | "degraded" | "unreachable";

export interface McpConnState {
  status: McpConnStatus;
  lastPingAt: number | null;
  latencyMs: number | null;
  toolsCount: number | null;
  error: string | null;
}

const IDLE_STATE: McpConnState = {
  status: "idle",
  lastPingAt: null,
  latencyMs: null,
  toolsCount: null,
  error: null,
};

interface UseMcpConnectionStatusOptions {
  headers?: Record<string, string>;
}

interface UseMcpConnectionStatusReturn {
  state: McpConnState;
  ping: () => Promise<void>;
}

function hostOf(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/**
 * Probe a remote MCP server with a JSON-RPC `tools/list` request. Stdio
 * servers return `idle` without ever fetching — they cannot be reached from
 * the renderer.
 */
export function useMcpConnectionStatus(
  server: McpServerConfig | null,
  opts: UseMcpConnectionStatusOptions = {},
): UseMcpConnectionStatusReturn {
  const [state, setState] = useState<McpConnState>(IDLE_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const { headers } = opts;

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const ping = useCallback(async () => {
    if (!server || !isRemote(server) || !server.url) {
      setState({ ...IDLE_STATE });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((prev) => ({ ...prev, status: "pinging", error: null }));
    const startedAt = performance.now();
    const host = hostOf(server.url);

    try {
      const res = await fetch(server.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(headers ?? {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
        signal: controller.signal,
      });
      const latencyMs = Math.round(performance.now() - startedAt);

      if (!res.ok) {
        const msg = `HTTP ${res.status}`;
        setState({
          status: "unreachable",
          lastPingAt: Date.now(),
          latencyMs,
          toolsCount: null,
          error: msg,
        });
        if (isSentryEnabled()) {
          Sentry.addBreadcrumb({
            category: "mcp.ping",
            message: msg,
            data: { host, status: "unreachable", latencyMs },
          });
        }
        return;
      }

      const body = await res.json().catch(() => null);
      const tools = body?.result?.tools;
      if (Array.isArray(tools)) {
        setState({
          status: "ok",
          lastPingAt: Date.now(),
          latencyMs,
          toolsCount: tools.length,
          error: null,
        });
        if (isSentryEnabled()) {
          Sentry.addBreadcrumb({
            category: "mcp.ping",
            data: { host, status: "ok", latencyMs, count: tools.length },
          });
        }
      } else {
        setState({
          status: "degraded",
          lastPingAt: Date.now(),
          latencyMs,
          toolsCount: null,
          error: body?.error?.message ?? "Protocol error",
        });
        if (isSentryEnabled()) {
          Sentry.addBreadcrumb({
            category: "mcp.ping",
            data: { host, status: "degraded", latencyMs },
          });
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Network error";
      setState({
        status: "unreachable",
        lastPingAt: Date.now(),
        latencyMs: null,
        toolsCount: null,
        error: message,
      });
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: "mcp.ping",
          message,
          data: { host, status: "unreachable" },
        });
      }
    }
  }, [server, headers]);

  return { state, ping };
}
