import { useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { invoke, isTauri } from "./use-tauri-ipc";
import { failJob, resolveProjectSlug } from "@/lib/api";
import type { SessionTracker } from "@/lib/session-tracker";
import type { JobAssignedPayload, ProjectConfig } from "@/lib/types";

export interface JobHandlerCtx {
  projects: Record<string, ProjectConfig>;
  tracker: Pick<SessionTracker, "start">;
  jobSessions: Set<string>;
  /**
   * Maps a local job/session key (jobId, since the runner uses jobId as
   * sessionId locally) to the linked agent_sessions row id surfaced by the
   * server in the `job.assigned` WS payload. The agent:complete handler
   * looks this up to PATCH the canonical session row with final messages,
   * claudeSessionId, and diff.
   */
  jobAgentSessions: Map<string, string>;
}

/**
 * Pure handler — no React. Tests call this directly. The hook below wires refs.
 *
 * ISS-115: the runner is a dumb subprocess executor. It consumes
 * `data.promptString` (server-built `/<skill> <issueId>`), spawns Claude
 * CLI, and streams events back. Zero pipeline knowledge here.
 */
export async function handleJobAssigned(
  data: JobAssignedPayload | undefined,
  ctx: JobHandlerCtx,
): Promise<void> {
  if (!data?.jobId) return;
  const { jobId, projectId, payload } = data;

  // Outside Tauri (browser/dev mode) `send_chat` is a logged no-op and no
  // agent:* events ever fire, so the job would sit dispatched forever. Fail
  // immediately so the dispatcher can move on.
  if (!isTauri) {
    try { await failJob(jobId, "device-runner unavailable in browser mode"); } catch { /* ignore */ }
    return;
  }

  let slug: string;
  try {
    slug = await resolveProjectSlug(projectId);
  } catch (err) {
    console.error("[job.assigned] resolve project slug failed:", err);
    try { await failJob(jobId, `project not found: ${projectId}`); } catch { /* ignore */ }
    return;
  }

  const pc = ctx.projects?.[slug];
  if (!pc?.repoPath) {
    try { await failJob(jobId, `no repoPath configured for project ${slug}`); } catch { /* ignore */ }
    return;
  }

  // Prefer the top-level field (post-ISS-115); fall back to payload.promptString
  // so a pre-0.1.34 server emitting the field only inside payload still works
  // across the rolling-update window.
  const payloadPrompt = typeof payload?.promptString === "string" ? payload.promptString : null;
  const prompt = data.promptString ?? payloadPrompt;
  if (!prompt) {
    // Permanent failure — server failure classifier maps `missing_prompt_string`
    // to `permanent` so retry/sweeper does not burn the retry cap.
    try { await failJob(jobId, "missing_prompt_string"); } catch { /* ignore */ }
    return;
  }

  const mcpServers = pc.mcpServers && Object.keys(pc.mcpServers).length > 0 ? pc.mcpServers : undefined;

  // Mark BEFORE invoke so any stream events emitted while invoke awaits land
  // in the job-events path (not the user-relay path). On failure we keep the
  // marker — late agent:* events for this jobId must not leak to chat UIs;
  // jobId is a UUID so growth is bounded and won't collide with real sessions.
  ctx.jobSessions.add(jobId);
  if (data.agentSessionId) {
    ctx.jobAgentSessions.set(jobId, data.agentSessionId);
  }
  ctx.tracker.start(jobId, slug, prompt, { repoPath: pc.repoPath, agentSessionId: data.agentSessionId ?? undefined });

  try {
    // PR-5 — if server sent claudeSessionId, this stage belongs to a
    // sessionGroup with a prior completed session on the same host. Pass it
    // through so Tauri spawns claude with --resume.
    await invoke("send_chat", {
      repoPath: pc.repoPath,
      message: prompt,
      sessionId: jobId,
      claudeSessionId: data.claudeSessionId ?? null,
      projectSlug: slug,
      // PR-4 — prefer mcpServersOverride from the per-state config; fall
      // back to the project-default `mcpServers` resolved above.
      mcpServers: data.mcpServersOverride ?? mcpServers,
      systemPrompt: data.systemPrompt ?? undefined,
      model: data.model ?? undefined,
      allowedTools: data.allowedTools ?? undefined,
      permissionMode: data.permissionMode ?? undefined,
      // PR-4 — per-state `timeoutSeconds` overrides the Rust 30-min default
      // when supplied. Cast to ensure Tauri serialises as `Option<u64>`.
      timeoutSeconds:
        typeof data.timeoutSeconds === "number" && data.timeoutSeconds > 0
          ? data.timeoutSeconds
          : undefined,
    });
  } catch (err) {
    console.error("[job.assigned] send_chat failed:", err);
    try { await failJob(jobId, `send_chat failed: ${String(err)}`); } catch { /* ignore */ }
  }
}

export interface JobAssignedHandlerRefs {
  handlerRef: React.MutableRefObject<(data: JobAssignedPayload) => Promise<void>>;
  jobSessionsRef: React.MutableRefObject<Set<string>>;
  cancelledJobsRef: React.MutableRefObject<Set<string>>;
  jobAgentSessionsRef: React.MutableRefObject<Map<string, string>>;
}

/**
 * React wrapper: keeps the handler ref fresh against the latest config without
 * recreating the WebSocket. The set of job-owned session IDs lives in a ref so
 * the agent:message/agent:complete listeners (in use-web-socket) can branch on
 * it cheaply. cancelledJobsRef tracks jobIds where job.cancel was received so
 * the eventual agent:complete reports the right exitCode (-1 = cancelled).
 */
export function useJobAssignedHandler(tracker: SessionTracker): JobAssignedHandlerRefs {
  const projects = useAppStore((s) => s.deviceSettings.projects);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const jobSessionsRef = useRef(new Set<string>());
  const cancelledJobsRef = useRef(new Set<string>());
  const jobAgentSessionsRef = useRef(new Map<string, string>());
  const handlerRef = useRef<(data: JobAssignedPayload) => Promise<void>>(async () => {});

  handlerRef.current = (data: JobAssignedPayload) =>
    handleJobAssigned(data, {
      projects: projectsRef.current,
      tracker,
      jobSessions: jobSessionsRef.current,
      jobAgentSessions: jobAgentSessionsRef.current,
    });

  return { handlerRef, jobSessionsRef, cancelledJobsRef, jobAgentSessionsRef };
}
