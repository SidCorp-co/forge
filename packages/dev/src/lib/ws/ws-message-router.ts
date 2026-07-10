// Event → handler registry for server WS frames, mirroring the pattern in
// packages/web-v2/src/lib/ws/event-router.ts (which uses a switch; here a
// registry map so multiple event aliases share one handler). Handlers receive
// the parsed `msg.data` plus a `WsRouterContext` instead of closing over the
// useWebSocket hook body. The old wildcard string-prefix fallthrough is the
// explicit `defaultHandler` below.
import type { QueryClient } from "@tanstack/react-query";
import { invoke } from "@/hooks/use-tauri-ipc";
import { completeJob } from "@/lib/api";
import { syncAllProjectSkills, syncProjectSkills } from "@/lib/skill-sync";
import { useAppStore } from "@/stores/app-store";

export type WsRouterContext = {
  queryClient: QueryClient;
  /** job.assigned → use-job-handler (spawns the local Claude agent). */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous payloads
  handleJobAssigned: (data: any) => void;
  /** agent:start / agent:send / … → use-agent-commands. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous payloads
  handleAgentCommand: (event: string, data: any) => void;
  /** Session IDs owned by pipeline jobs (see use-job-handler). */
  jobSessionsRef: { current: Set<string> };
  /** jobIds tagged by job.cancel so agent:complete maps to exitCode -1. */
  cancelledJobsRef: { current: Set<string> };
};

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous payloads
type WsHandler = (event: string, data: any, ctx: WsRouterContext) => void;

// Server-commanded skill sync. The ONLY path that makes this device pull
// skills: fired when a web Sync action (Skill Studio or device management)
// or the forge_skills.push MCP tool targets this device. No bodies are in
// the payload — we pull the project's effective manifest and install it.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous payloads
async function handleSkillSync(data: any, queryClient: QueryClient) {
  const projectSlug: string | undefined = data?.projectSlug;
  try {
    if (projectSlug) {
      await syncProjectSkills(projectSlug, "");
    } else {
      // Fallback: no slug carried — refresh every configured project.
      const settings = useAppStore.getState().deviceSettings;
      await syncAllProjectSkills(settings.projects);
    }
  } catch (err) {
    console.error("[skill.sync] failed:", err);
  }
  queryClient.invalidateQueries({ queryKey: ["skill-sync-log"] });
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous payloads
async function handleConfigSyncProject(data: any) {
  const { projectSlug, repoPath } = data || {};
  if (!projectSlug || !repoPath) return;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: config shape is dynamic
    const currentConfig = await invoke<any>("get_config");
    const projects = { ...currentConfig.projects };
    const existing = projects[projectSlug] || { slug: projectSlug };
    if (existing.repoPath === repoPath) return; // already set
    projects[projectSlug] = { ...existing, repoPath };
    await invoke("save_config", { config: { ...currentConfig, projects } });
  } catch { /* ignore */ }
}

const handleAgentCommandEvent: WsHandler = (event, data, ctx) => {
  ctx.handleAgentCommand(event, data);
};

const handleNotificationCreated: WsHandler = (_event, _data, ctx) => {
  ["notifications", "notifications-unread", "pm-escalations"].forEach((k) =>
    ctx.queryClient.invalidateQueries({ queryKey: [k], refetchType: "all" }),
  );
  // NOTE: the original if/else chain did NOT return after this branch and fell
  // through to the string-prefix fallthrough — a no-op for `notification:*`
  // names — so ending here is behavior-identical.
};

const registry: Record<string, WsHandler> = {
  "job.assigned": (_event, data, ctx) => {
    ctx.handleJobAssigned(data);
  },

  "job.cancel": (_event, data, ctx) => {
    const jobId = data?.jobId;
    if (jobId) {
      // Tag the job as cancelled so the eventual agent:complete maps to
      // exitCode -1 (cancelled), not 1 (failed → triggers retry).
      ctx.cancelledJobsRef.current.add(jobId);
      // If abort fails (e.g. cancel arrived before send_chat registered
      // the session locally), agent:complete will never fire and the
      // job would sit dispatched forever. Converge directly by posting
      // /complete with exitCode -1 so the dispatcher records cancelled
      // rather than failed (which would also trigger scheduleRetry).
      invoke("abort_agent", { sessionId: jobId }).catch(async () => {
        ctx.jobSessionsRef.current.delete(jobId);
        ctx.cancelledJobsRef.current.delete(jobId);
        try { await completeJob(jobId, -1, { error: "cancelled before runner accepted job" }); } catch { /* ignore */ }
      });
    }
  },

  "agent:start": handleAgentCommandEvent,
  "agent:send": handleAgentCommandEvent,
  "agent:abort": handleAgentCommandEvent,
  "agent:build-prompt": handleAgentCommandEvent,
  "agent:review": handleAgentCommandEvent,
  "agent:reindex": handleAgentCommandEvent,

  "skill.sync": (_event, data, ctx) => {
    void handleSkillSync(data, ctx.queryClient);
  },

  // ISS-173: server confirms the runner registration; record it so the
  // PairDeviceCard + ProjectSettings badge can surface "Active runner here".
  "runner.registered": handleRunnerRegistered,
  "runner:registered": handleRunnerRegistered,

  // ISS-175: core emits `runner.status` (not `runner.disconnected`) from
  // both heartbeat-ws.ts (explicit unregister) and stale-detector.ts
  // (heartbeat lapse), broadcast to projectRoom(projectId). The project
  // room carries status for every runner in the project — only update
  // when the runnerId matches the one this device recorded on
  // runner.registered, otherwise a peer device's transition would
  // clobber our local binding.
  "runner.status": (_event, data, _ctx) => {
    const projectId = data?.projectId;
    const runnerId = data?.runnerId ?? data?.id;
    const status = data?.status;
    if (!projectId || !runnerId || !status) return;
    const current = useAppStore.getState().runnerBindings[String(projectId)];
    if (!current || current.runnerId !== String(runnerId)) return;
    if (status === "offline" || status === "online") {
      useAppStore.getState().setRunnerBinding(String(projectId), {
        runnerId: String(runnerId),
        status,
      });
    }
  },

  // EPIC 6 (ISS-278/290/292) — a project skill changed on the server.
  // This is cache-invalidation ONLY; it must NOT make the device pull.
  // A device syncs only on an explicit `skill.sync` command. The web
  // freshness view will show this device as "outdated" until then.
  "skill.updated": (_event, _data, ctx) => {
    ctx.queryClient.invalidateQueries({ queryKey: ["skill-sync-log"] });
  },

  "config:sync-project": (_event, data, _ctx) => {
    void handleConfigSyncProject(data);
  },

  "notification:created": handleNotificationCreated,
  "notification.created": handleNotificationCreated,

  // ISS-22 — PM agent escalation. Broadcast by Epic 5; refresh the
  // inbox + notifications cache so the bell badge and PmInbox pick it up.
  "pm.escalation": (_event, _data, ctx) => {
    ["pm-escalations", "notifications", "notifications-unread"].forEach((k) =>
      ctx.queryClient.invalidateQueries({ queryKey: [k], refetchType: "all" }),
    );
  },
};

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous payloads
function handleRunnerRegistered(_event: string, data: any, _ctx: WsRouterContext) {
  const projectId = data?.projectId;
  const runnerId = data?.runnerId ?? data?.id;
  if (projectId && runnerId) {
    useAppStore.getState().setRunnerBinding(String(projectId), {
      runnerId: String(runnerId),
      status: "online",
    });
  }
}

/**
 * Wildcard fallthrough (the tail of the old if/else chain): any `issue:*` /
 * `task:*` / `agent:*` event WITHOUT an explicit registry entry invalidates
 * the coarse react-query buckets by string prefix. All other unknown events
 * are ignored.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous payloads
function defaultHandler(event: string, _data: any, ctx: WsRouterContext) {
  if (
    event.startsWith("issue:") ||
    event.startsWith("task:") ||
    event.startsWith("agent:")
  ) {
    const keys =
      event.startsWith("task:") || event.startsWith("agent:")
        ? ["tasks"]
        : ["issues", "issue", "comments"];
    keys.forEach((k) =>
      ctx.queryClient.invalidateQueries({ queryKey: [k], refetchType: "all" }),
    );
  }
}

/**
 * Parse + dispatch one raw WS frame (string or already-parsed object).
 * Any parse/handler throw is swallowed, matching the old inline handleMessage.
 */
export function routeWsMessage(raw: unknown, ctx: WsRouterContext): void {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous payloads
    const msg: any = typeof raw === "string" ? JSON.parse(raw) : raw;
    const event: string = msg.event ?? "";
    // Trace via console.warn so fe_log forwarder relays to stdout for debugging
    console.warn(`[ws-msg] ${event || "(no event)"}`, msg.data ? Object.keys(msg.data).join(",") : "");

    const handler = registry[event] ?? defaultHandler;
    handler(event, msg.data, ctx);
  } catch {
    // ignore
  }
}
