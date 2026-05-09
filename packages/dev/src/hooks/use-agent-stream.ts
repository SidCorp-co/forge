import { useCallback, useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "./use-tauri-ipc";
import { parseStreamMessages } from "@/lib/stream-parser";
import { updateTask, createUsageRecord } from "@/lib/api";
import type { AgentMessage, Task } from "@/lib/types";

const RELAY_INTERVAL_MS = 5000;

const EMPTY_USAGE_ACC = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, model: "unknown", count: 0 };

export function useAgentStream() {
  const {
    agentMessages,
    agentRunning,
    agentSessionId,
    addAgentMessage,
    clearAgentMessages,
    setAgentRunning,
    setAgentSessionId,
    updateAgentUsage,
    resetAgentUsage,
  } = useAppStore();

  const relayRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const pendingLogRef = useRef<AgentMessage[]>([]);
  const usageAccRef = useRef({ ...EMPTY_USAGE_ACC });
  const lastMsgIdRef = useRef<string | null>(null);

  const flushPendingLog = useCallback(() => {
    if (pendingLogRef.current.length === 0 || !taskIdRef.current) return;
    const logEntries = pendingLogRef.current.map((m) => {
      let content: string;
      switch (m.type) {
        case "assistant": content = m.content ?? ""; break;
        case "tool_use": content = `[tool: ${m.toolName}]`; break;
        case "tool_result": content = `[result: ${(m.toolOutput ?? "").slice(0, 200)}]`; break;
        default: content = m.content ?? "";
      }
      return { type: m.type, content, timestamp: m.timestamp };
    });
    pendingLogRef.current = [];
    updateTask(taskIdRef.current, { agentLog: logEntries } as Partial<Task>).catch(() => {});
  }, []);

  // Batch relay agent log to core every 5s
  useEffect(() => {
    if (agentRunning && taskIdRef.current) {
      relayRef.current = setInterval(flushPendingLog, RELAY_INTERVAL_MS);
    }
    return () => {
      if (relayRef.current) clearInterval(relayRef.current);
    };
  }, [agentRunning, flushPendingLog]);

  useEffect(() => {
    let unlistenMsg: (() => void) | undefined;
    let unlistenComplete: (() => void) | undefined;

    async function setup() {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlistenMsg = await listen("agent:message", (event) => {
          const payload = event.payload as Record<string, unknown>;
          const rawData = payload.data as Record<string, unknown> | undefined;
          // Claude CLI sends multiple entries per API turn (same message.id)
          const apiMsgId = (rawData?.message as Record<string, unknown> | undefined)?.id as string | undefined;
          const { messages: msgs } = parseStreamMessages(rawData);
          for (const msg of msgs) {
            addAgentMessage(msg);
            pendingLogRef.current.push(msg);
            // Accumulate usage from assistant messages (dedup by message.id)
            if (msg.type === "assistant" && msg.usage) {
              const isNewTurn = !apiMsgId || apiMsgId !== lastMsgIdRef.current;
              if (isNewTurn) lastMsgIdRef.current = apiMsgId ?? null;
              if (isNewTurn) updateAgentUsage(msg.usage);
              if (isNewTurn) {
                usageAccRef.current.input += msg.usage.input_tokens || 0;
                usageAccRef.current.output += msg.usage.output_tokens || 0;
                usageAccRef.current.cacheRead += msg.usage.cache_read_input_tokens || 0;
                usageAccRef.current.cacheCreation += msg.usage.cache_creation_input_tokens || 0;
                usageAccRef.current.count += 1;
              }
              if (msg.model) {
                usageAccRef.current.model = msg.model;
              }
            }
          }
        });
        unlistenComplete = await listen("agent:complete", (event) => {
          setAgentRunning(false);
          const payload = event.payload as Record<string, unknown>;
          const error = payload.error as string | undefined;

          // Flush any remaining pending log entries
          flushPendingLog();

          if (taskIdRef.current) {
            updateTask(taskIdRef.current, {
              agentStatus: error ? "failed" : "completed",
              status: error ? undefined : "done",
            } as Partial<Task>).catch(() => {});
          }
          // Post accumulated usage to core (cost calculated server-side)
          const acc = usageAccRef.current;
          if (acc.count > 0) {
            createUsageRecord({
              source: "desktop",
              model: acc.model,
              inputTokens: acc.input,
              outputTokens: acc.output,
              cacheReadTokens: acc.cacheRead,
              cacheCreationTokens: acc.cacheCreation,
              requestCount: acc.count,
              sessionId: (payload.sessionId as string) || undefined,
              recordedAt: new Date().toISOString(),
            }).catch(() => {});
          }
          usageAccRef.current = { ...EMPTY_USAGE_ACC };
        });
      } catch {
        // Not in Tauri environment
      }
    }
    setup();
    return () => {
      unlistenMsg?.();
      unlistenComplete?.();
    };
  }, [addAgentMessage, setAgentRunning, flushPendingLog]);

  const startAgent = useCallback(
    async (repoPath: string, prompt: string, taskId?: string) => {
      clearAgentMessages();
      setAgentRunning(true);
      resetAgentUsage();
      pendingLogRef.current = [];
      taskIdRef.current = taskId ?? null;
      usageAccRef.current = { ...EMPTY_USAGE_ACC };
      lastMsgIdRef.current = null;

      if (taskId) {
        await updateTask(taskId, { agentStatus: "running" } as Partial<Task>).catch(
          () => {},
        );
      }

      const sessionId = await invoke<string>("run_agent", {
        repoPath,
        prompt,
      }).catch((err) => {
        console.error("[agent] run_agent failed:", err);
        setAgentRunning(false);
        throw err;
      });
      setAgentSessionId(sessionId);
    },
    [clearAgentMessages, setAgentRunning, setAgentSessionId],
  );

  const abortAgent = useCallback(async () => {
    if (agentSessionId) {
      await invoke("abort_agent", { sessionId: agentSessionId });
      setAgentRunning(false);
      if (taskIdRef.current) {
        await updateTask(taskIdRef.current, {
          agentStatus: "failed",
        } as Partial<Task>).catch(() => {});
      }
    }
  }, [agentSessionId, setAgentRunning]);

  const startBatch = useCallback(
    async (repoPath: string, tasks: Task[]) => {
      clearAgentMessages();
      setAgentRunning(true);
      resetAgentUsage();
      pendingLogRef.current = [];
      taskIdRef.current = tasks[0]?.documentId ?? null;
      usageAccRef.current = { ...EMPTY_USAGE_ACC };
      lastMsgIdRef.current = null;

      const prompt = tasks
        .map(
          (t, i) =>
            `--- Task ${i + 1} of ${tasks.length}: ${t.title} ---\n${t.description}\n${
              t.acceptanceCriteria
                ?.map((c) => `- [ ] ${c}`)
                .join("\n") ?? ""
            }`,
        )
        .join("\n\n");

      for (const t of tasks) {
        await updateTask(t.documentId, { agentStatus: "running" } as Partial<Task>).catch(
          () => {},
        );
      }

      const sessionId = await invoke<string>("run_agent", {
        repoPath,
        prompt,
      }).catch((err) => {
        console.error("[agent] run_agent (batch) failed:", err);
        setAgentRunning(false);
        throw err;
      });
      setAgentSessionId(sessionId);
    },
    [clearAgentMessages, setAgentRunning, setAgentSessionId],
  );

  return {
    messages: agentMessages,
    isRunning: agentRunning,
    startAgent,
    startBatch,
    abortAgent,
  };
}
