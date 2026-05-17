import { useCallback, useEffect, useRef, useState } from "react";
import type { McpServerConfig } from "@/lib/types";
import { isRemote } from "@/components/settings/mcp-server-list/helpers";
import { Sentry, isSentryEnabled } from "@/lib/sentry";

export interface McpToolEntry {
  name: string;
  description?: string;
}

interface UseMcpToolsReturn {
  tools: McpToolEntry[] | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface UseMcpToolsOptions {
  headers?: Record<string, string>;
}

interface CacheEntry {
  tools: McpToolEntry[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function authHashOf(headers: Record<string, string> | undefined): string {
  if (!headers) return "no-auth";
  const auth = headers.Authorization ?? "";
  if (!auth) return "no-auth";
  return auth.slice(-8);
}

function cacheKey(url: string, headers: Record<string, string> | undefined): string {
  return `${url}::${authHashOf(headers)}`;
}

function hostOf(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export function useMcpTools(
  server: McpServerConfig | null,
  enabled: boolean,
  opts: UseMcpToolsOptions = {},
): UseMcpToolsReturn {
  const [tools, setTools] = useState<McpToolEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { headers } = opts;

  const fetchTools = useCallback(
    async (skipCache: boolean) => {
      if (!server || !isRemote(server) || !server.url) {
        setTools(null);
        setError(null);
        setLoading(false);
        return;
      }
      const key = cacheKey(server.url, headers);
      if (!skipCache) {
        const hit = cache.get(key);
        if (hit) {
          setTools(hit.tools);
          setError(null);
          setLoading(false);
          return;
        }
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const raw = body?.result?.tools;
        if (!Array.isArray(raw)) throw new Error("Invalid tools/list response");
        const list: McpToolEntry[] = raw.map((t: { name: string; description?: string }) => ({
          name: t.name,
          description: t.description,
        }));
        cache.set(key, { tools: list, fetchedAt: Date.now() });
        setTools(list);
        if (isSentryEnabled()) {
          Sentry.addBreadcrumb({
            category: "mcp.tools.list",
            data: { host, count: list.length, error: false },
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        const message = err instanceof Error ? err.message : "Failed to list tools";
        setError(message);
        if (isSentryEnabled()) {
          Sentry.addBreadcrumb({
            category: "mcp.tools.list",
            message,
            data: { host, error: true },
          });
        }
      } finally {
        setLoading(false);
      }
    },
    [server, headers],
  );

  useEffect(() => {
    if (!enabled) return;
    void fetchTools(false);
    return () => {
      abortRef.current?.abort();
    };
  }, [enabled, fetchTools]);

  const refetch = useCallback(() => {
    void fetchTools(true);
  }, [fetchTools]);

  return { tools, loading, error, refetch };
}

/** Test-only: clear the module-level cache between Vitest runs. */
export function __clearMcpToolsCache() {
  cache.clear();
}
