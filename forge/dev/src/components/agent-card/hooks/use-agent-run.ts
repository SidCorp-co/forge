import { useState, useRef, useEffect, useCallback } from "react";
import { startAgentSession } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import type { Agent } from "@/lib/types";

interface UseAgentRunOptions {
  agent: Agent;
  slug: string;
}

export interface AgentRunState {
  poLoading: "review" | "reindex" | null;
  runStatus: string | null;
  runLog: string[];
  logEndRef: React.RefObject<HTMLDivElement | null>;
  handlePoAction: (action: "review" | "reindex") => Promise<void>;
}

export function useAgentRun({ agent, slug }: UseAgentRunOptions): AgentRunState {
  const [poLoading, setPoLoading] = useState<"review" | "reindex" | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<string[]>([]);
  const runSessionRef = useRef<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const { config } = useAppStore();
  const projectConfig = config.projects?.[slug];

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");

        const ul = await listen<{ sessionId: string; data: Record<string, unknown> }>(
          "agent:message",
          (event) => {
            if (cancelled) return;
            const { sessionId, data } = event.payload;
            if (sessionId !== runSessionRef.current) return;

            if (data.type === "assistant") {
              const msg = data.message as Record<string, unknown> | undefined;
              const content = msg?.content as Array<{ type: string; text?: string; name?: string }> | undefined;
              if (Array.isArray(content)) {
                for (const c of content) {
                  if (c.type === "text" && c.text) {
                    setRunLog((prev) => [...prev, c.text!]);
                  } else if (c.type === "tool_use") {
                    const input = (c as Record<string, unknown>).input as Record<string, unknown> | undefined;
                    let detail = "";
                    if (c.name === "Bash" && input?.command) detail = ` $ ${String(input.command).slice(0, 120)}`;
                    else if ((c.name === "Read" || c.name === "Write" || c.name === "Edit") && input?.file_path) detail = ` ${input.file_path}`;
                    else if ((c.name === "Glob" || c.name === "Grep") && input?.pattern) detail = ` ${input.pattern}`;
                    else if (input) detail = ` ${JSON.stringify(input).slice(0, 100)}`;
                    setRunLog((prev) => [...prev, `⚡ ${c.name ?? "tool"}${detail}`]);
                  }
                }
              }
            } else if (data.type === "system") {
              const msg = (data.message as string) ?? "";
              if (msg) setRunLog((prev) => [...prev, msg]);
            }

            if (data.type === "result") {
              const failed = (data.is_error as boolean) ?? false;
              setRunStatus(failed ? "Run failed" : "Run complete!");
              setPoLoading(null);
              runSessionRef.current = null;
              setTimeout(() => setRunStatus(null), 5000);
            }
          },
        );
        if (cancelled) { ul(); return; }
        unlisten = ul;

        const ul2 = await listen<{ sessionId: string; error?: string }>(
          "agent:complete",
          (event) => {
            if (cancelled) return;
            if (event.payload.sessionId !== runSessionRef.current) return;
            if (event.payload.error) {
              setRunLog((prev) => [...prev, `Error: ${event.payload.error}`]);
              setRunStatus("Run failed");
            } else {
              setRunStatus("Run complete!");
            }
            setPoLoading(null);
            runSessionRef.current = null;
            setTimeout(() => setRunStatus(null), 5000);
          },
        );
        if (cancelled) { ul2(); return; }
        const origUnlisten = unlisten;
        unlisten = () => { origUnlisten?.(); ul2(); };
      } catch {}
    })();

    return () => { cancelled = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [runLog]);

  const handlePoAction = useCallback(async (action: "review" | "reindex") => {
    setPoLoading(action);
    setRunStatus(action === "review" ? "Running review..." : "Refreshing knowledge...");
    setRunLog([]);
    try {
      if (!agent.type) throw new Error("Agent has no type");
      const agentType = agent.type;
      const type = action === "review" ? agentType : `${agentType}-reindex`;
      const res = await startAgentSession(slug, type, projectConfig?.repoPath, undefined, true);
      runSessionRef.current = res.documentId;
    } catch {
      setPoLoading(null);
      setRunStatus("Failed to start");
      setTimeout(() => setRunStatus(null), 3000);
    }
  }, [slug, projectConfig, agent.type]);

  return { poLoading, runStatus, runLog, logEndRef, handlePoAction };
}
