import { parseStreamMessages } from "@/lib/stream-parser";

/**
 * Pipeline usage accumulator. Keyed by local Tauri sessionId (jobId for
 * pipeline jobs). Cleared on agent:complete after the row is POSTed to
 * /usage-records. Dedup `seenIds` matches the Rust JSONL parser pattern
 * (claude_cli/usage.rs:158) — Claude CLI emits multiple stream entries per
 * API turn that share the same `message.id`.
 *
 * Module-level so the lifecycle survives hook remounts during an active
 * dispatch — the useWebSocket effect can tear down and re-run (auth/config
 * changes) while a job is still streaming, and the accumulated totals must
 * survive that remount.
 */
export type UsageAcc = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  model: string;
  count: number;
  seenIds: Set<string>;
};

const usageAccByJob = new Map<string, UsageAcc>();

function getOrInitUsageAcc(sessionId: string): UsageAcc {
  let acc = usageAccByJob.get(sessionId);
  if (!acc) {
    acc = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      model: "unknown",
      count: 0,
      seenIds: new Set(),
    };
    usageAccByJob.set(sessionId, acc);
  }
  return acc;
}

/**
 * Feed one `agent:message` stream chunk into the per-job accumulator so
 * agent:complete can POST a single /usage-records row keyed by the forge
 * agentSessionId. The pipeline_run_step_durations view JOINs
 * `ur.session_id = j.agent_session_id::text` — without this path every
 * pipeline step shows totalCostUsd=0.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous stream payloads
export function accumulateJobUsage(sessionId: string, agentData: any): void {
  try {
    const apiMsgId = (agentData?.message as Record<string, unknown> | undefined)
      ?.id as string | undefined;
    const { messages: msgs } = parseStreamMessages(agentData);
    for (const msg of msgs) {
      if (msg.type === "assistant" && msg.usage) {
        const acc = getOrInitUsageAcc(sessionId);
        if (apiMsgId) {
          if (acc.seenIds.has(apiMsgId)) continue;
          acc.seenIds.add(apiMsgId);
        }
        acc.input += msg.usage.input_tokens || 0;
        acc.output += msg.usage.output_tokens || 0;
        acc.cacheRead += msg.usage.cache_read_input_tokens || 0;
        acc.cacheCreation += msg.usage.cache_creation_input_tokens || 0;
        acc.count += 1;
        if (msg.model) acc.model = msg.model;
      }
    }
  } catch {
    /* parse failures are non-fatal — usage gets a 0-cost row */
  }
}

/** Read the accumulated usage for a job session (undefined if never fed). */
export function readJobUsage(sessionId: string): UsageAcc | undefined {
  return usageAccByJob.get(sessionId);
}

/** Drop the accumulator entry for a job session (after the row is POSTed). */
export function clearJobUsage(sessionId: string): void {
  usageAccByJob.delete(sessionId);
}
